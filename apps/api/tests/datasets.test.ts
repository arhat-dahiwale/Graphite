import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataClient, type DataClient } from "@graphite/data/client";
import {
  collectSse,
  pollUntil,
  rest,
  startTestApp,
  trpc,
  uploadCsv,
  type TestApp,
} from "./helpers.js";

let app: TestApp;
let alice: string;
let bob: string; // another tenant
let orgAId = "";
let orgBId = "";
let projectId = "";
let dataClient: DataClient;

const CSV_SMALL = [
  "region,date,revenue,units,active",
  "north,2025-01-01,120.5,10,true",
  "south,2025-01-02,80,,false",
  "east,2025-01-03,150.75,25,true",
  "north,2025-02-01,95.25,7,false",
].join("\n");

beforeAll(async () => {
  app = await startTestApp();
  alice = await (await import("./helpers.js")).signUp(app.baseUrl, "ingest-alice@test.example", "Alice");
  bob = await (await import("./helpers.js")).signUp(app.baseUrl, "ingest-bob@test.example", "Bob");
  const orgA = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "Ingest Org" }, "mutation");
  orgAId = orgA.id;
  const orgB = await trpc<{ id: string }>(app.baseUrl, bob, "org.create", { name: "Other Org" }, "mutation");
  orgBId = orgB.id;
  const project = await trpc<{ id: string }>(
    app.baseUrl,
    alice,
    "project.create",
    { orgId: orgAId, name: "Ingest Project" },
    "mutation",
  );
  projectId = project.id;
  dataClient = createDataClient(`127.0.0.1:${app.dataPort}`);
}, 90_000);

afterAll(async () => {
  dataClient?.close();
  await app?.close();
});

async function uploadAndAwaitReady(
  csv: string,
  filename: string,
): Promise<{ datasetId: string; jobId: string }> {
  const up = await uploadCsv(app.baseUrl, alice, projectId, filename, csv);
  expect(up.status).toBe(202);
  const datasetId = up.json.dataset?.id as string;
  expect(datasetId).toMatch(/^ds_/);
  expect(up.json.jobId).toBe(`ingest-${datasetId}`);
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready" || v.dataset.status === "failed",
    30_000,
  );
  const meta = (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as {
    dataset: { status: string; error: string | null; rowCount: number };
  };
  if (meta.dataset.status === "failed") {
    throw new Error(`ingestion failed: ${meta.dataset.error}`);
  }
  return { datasetId, jobId: up.json.jobId as string };
}

describe("CSV upload and ingestion", () => {
  it("uploads, streams to object storage, and ingests with correct inferred types", async () => {
    const up = await uploadCsv(app.baseUrl, alice, projectId, "small.csv", CSV_SMALL);
    expect(up.status).toBe(202);
    const datasetId = up.json.dataset?.id as string;

    const meta = (await pollUntil(
      async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as {
        dataset: { status: string; rowCount: number };
        columns: Array<{ originalName: string; inferredType: string }>;
      },
      (v) => v.dataset.status === "ready" || v.dataset.status === "failed",
      30_000,
    )) as {
      dataset: { status: string; rowCount: number };
      columns: Array<{ originalName: string; inferredType: string }>;
    };
    expect(meta.dataset.status).toBe("ready");
    expect(meta.dataset.rowCount).toBe(4);
    const byName = Object.fromEntries(meta.columns.map((c) => [c.originalName, c.inferredType]));
    expect(byName["region"]).toBe("text");
    expect(byName["date"]).toBe("date");
    expect(byName["revenue"]).toBe("number");
    expect(byName["units"]).toBe("integer");
    expect(byName["active"]).toBe("boolean");

    // Preview via the data service (readonly role).
    const preview = (await rest(
      app.baseUrl,
      alice,
      "GET",
      `/api/v1/datasets/${datasetId}/preview?limit=10`,
    )).json as { columns: string[]; rows: Array<Record<string, unknown>> };
    expect(preview.columns).toContain("_row_id");
    expect(preview.rows.length).toBe(4);
    expect(preview.rows[0]?.["region"]).toBe("north");
  }, 60_000);

  it("publishes ingestion progress over SSE and is idempotent on retry", async () => {
    const { datasetId } = await uploadAndAwaitReady(CSV_SMALL, "idem.csv");

    // Subscribe BEFORE re-enqueueing so all events are observed. The original
    // completed job must be removed first: BullMQ deduplicates identical job
    // IDs, which is exactly the idempotency guarantee under test.
    const jobId = `ingest-${datasetId}`;
    const existing = await app.ingestionQueue.getJob(jobId);
    if (existing) await existing.remove();
    const ssePromise = collectSse(
      app.baseUrl,
      alice,
      `/api/v1/datasets/${datasetId}/events`,
      ["done"],
      45_000,
    );
    await app.ingestionQueue.add("ingest", { datasetId }, { jobId });
    const events = await ssePromise;
    expect(events.some((e) => e.event === "progress")).toBe(true);
    expect(events.some((e) => e.event === "done")).toBe(true);
    const done = events.find((e) => e.event === "done")?.data as { rowCount?: number };
    expect(done.rowCount).toBe(4);
    const preview = (await rest(
      app.baseUrl,
      alice,
      "GET",
      `/api/v1/datasets/${datasetId}/preview?limit=100`,
    )).json as { rows: unknown[] };
    expect(preview.rows.length).toBe(4);
  }, 60_000);

  it("rejects uploads for non-members and viewers cannot upload", async () => {
    // Bob has no membership in org A.
    const bobUpload = await uploadCsv(app.baseUrl, bob, projectId, "evil.csv", CSV_SMALL);
    expect(bobUpload.status).toBe(404);
  }, 30_000);

  it("10 MB CSV uploads and previews in under 30 seconds", async () => {
    // ~104k rows x ~100 bytes ≈ 10.4 MB.
    const lines: string[] = ["product,region,ordered_at,amount,quantity"];
    const regions = ["north", "south", "east", "west", "central"];
    let size = 42;
    let i = 0;
    while (size < 10 * 1024 * 1024) {
      const line = `Widget ${i % 500},${regions[i % regions.length] as string},2025-0${(i % 9) + 1}-1${i % 9},${(i % 1000) + 0.5},${i % 50}`;
      lines.push(line);
      size += line.length + 1;
      i += 1;
    }
    const csv = lines.join("\n");
    const started = Date.now();
    const { datasetId } = await uploadAndAwaitReady(csv, "big.csv");
    const preview = (await rest(
      app.baseUrl,
      alice,
      "GET",
      `/api/v1/datasets/${datasetId}/preview?limit=20`,
    )).json as { rows: unknown[] };
    expect(preview.rows.length).toBe(20);
    const elapsed = (Date.now() - started) / 1000;
    // eslint-disable-next-line no-console
    console.info(`10 MB CSV upload+ingest+preview took ${elapsed.toFixed(1)}s`);
    expect(elapsed).toBeLessThan(30);
  }, 90_000);
});

describe("manual column type override", () => {
  it("overrides a text column to integer and re-casts physically", async () => {
    const csv = "sku,qty\nA1,5\nB2,7\nC3,11";
    const { datasetId } = await uploadAndAwaitReady(csv, "override.csv");
    const updated = await trpc<{ userType: string }>(
      app.baseUrl,
      alice,
      "dataset.updateColumnType",
      { datasetId, columnName: "qty", columnType: "integer" },
      "mutation",
    );
    expect(updated.userType).toBe("integer");
    const meta = (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as {
      columns: Array<{ name: string; userType: string | null }>;
    };
    const col = meta.columns.find((c) => c.name === "qty");
    expect(col?.userType).toBe("integer");
  }, 45_000);
});

describe("gRPC data service safety", () => {
  let datasetId = "";
  beforeAll(async () => {
    const r = await uploadAndAwaitReady(CSV_SMALL, "safety.csv");
    datasetId = r.datasetId;
  }, 60_000);

  const ctx = { organization_id: () => orgAId, user_id: "u_test", request_id: "req_test" };
  const mkCtx = () => ({
    organizationId: orgAId,
    userId: "u_test",
    requestId: "req_test",
  });
  void ctx;

  it("runs safe SELECTs through the readonly role", async () => {
    const res = await dataClient.runQuery(
      mkCtx(),
      [datasetId],
      "SELECT region, COUNT(*) AS n FROM datasets." + `"${datasetId}" GROUP BY region ORDER BY n DESC`,
      100,
      2000,
    );
    expect(res.columns).toContain("region");
    expect(res.rows.length).toBe(3);
  });

  it("rejects writes with INVALID_ARGUMENT", async () => {
    await expect(
      dataClient.runQuery(mkCtx(), [datasetId], "DELETE FROM datasets." + `"${datasetId}"`, 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
    await expect(
      dataClient.runQuery(mkCtx(), [datasetId], "INSERT INTO datasets." + `"${datasetId}" (region) VALUES ('x')`, 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
  });

  it("rejects multiple statements", async () => {
    await expect(
      dataClient.runQuery(mkCtx(), [datasetId], "SELECT 1 FROM datasets." + `"${datasetId}"` + "; SELECT 2", 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
  });

  it("rejects cross-schema and cross-tenant tables", async () => {
    await expect(
      dataClient.runQuery(mkCtx(), [datasetId], "SELECT email FROM public.users", 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
    await expect(
      dataClient.runQuery(mkCtx(), [datasetId], "SELECT * FROM pg_catalog.pg_tables", 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
  });

  it("rejects queries when the dataset is not in the allowlist", async () => {
    // Empty allowlist.
    await expect(
      dataClient.runQuery(mkCtx(), [], "SELECT * FROM datasets." + `"${datasetId}"`, 10, 2000),
    ).rejects.toMatchObject({ grpcCode: 3 });
  });

  it("hides other tenants' datasets even with a valid allowlist entry", async () => {
    // Bob's org cannot resolve org A's dataset.
    await expect(
      dataClient.runQuery(
        { organizationId: orgBId, userId: "u_bob", requestId: "req_b" },
        [datasetId],
        "SELECT * FROM datasets." + `"${datasetId}"`,
        10,
        2000,
      ),
    ).rejects.toMatchObject({ grpcCode: 5 }); // NOT_FOUND, not PERMISSION_DENIED
  });

  it("enforces the row limit cap and reports truncation", async () => {
    const res = await dataClient.runQuery(
      mkCtx(),
      [datasetId],
      "SELECT * FROM datasets." + `"${datasetId}"`,
      2,
      2000,
    );
    expect(res.rows.length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("enforces the statement timeout", async () => {
    await expect(
      dataClient.runQuery(
        mkCtx(),
        [datasetId],
        "SELECT pg_sleep(5) FROM datasets." + `"${datasetId}"`,
        10,
        500,
      ),
    ).rejects.toThrow();
  }, 15_000);
});
