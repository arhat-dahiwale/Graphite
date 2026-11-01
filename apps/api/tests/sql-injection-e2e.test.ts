import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pollUntil,
  rest,
  signUp,
  startTestApp,
  trpc,
  uploadCsv,
  type TestApp,
} from "./helpers.js";

/**
 * Phase 8 security: SQL injection through the chart query path. Filter
 * values and other user-controlled inputs must be escaped/validated by the
 * chart query compiler and re-checked by the data service AST gate — never
 * interpreted as SQL.
 */

let app: TestApp;
let alice: string;
let orgId = "";
let projectId = "";
let datasetId = "";

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "sqli-alice@test.example", "Alice");
  const org = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "SQLi Org" }, "mutation");
  orgId = org.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId, name: "SQLi Project" }, "mutation");
  projectId = project.id;
  const up = await uploadCsv(
    app.baseUrl,
    alice,
    projectId,
    "sqli.csv",
    "region,revenue\nnorth,120\nsouth,80\nnorth,60",
  );
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
}, 150_000);

afterAll(async () => {
  await app?.close();
});

const baseSpec = (filterValue: string) => ({
  version: 1,
  type: "bar",
  title: "Injection probe",
  datasetId,
  query: {
    select: [{ field: "region" }, { field: "revenue", agg: "sum", as: "total_revenue" }],
    filter: [{ field: "region", op: "eq", value: filterValue }],
    groupBy: ["region"],
    limit: 50,
  },
  encoding: {
    x: { field: "region", type: "category" as const },
    y: { field: "total_revenue", type: "number" as const },
  },
  style: { palette: "graphite" as const, legend: false, stack: false },
});

describe("SQL injection through chart.data (end to end)", () => {
  it("treats an injection payload as a literal filter value", async () => {
    const created = await trpc<{ chart: { id: string } }>(
      app.baseUrl,
      alice,
      "chart.create",
      { datasetId, spec: baseSpec("north' OR 1=1 --") },
      "mutation",
    );
    // The query must compile and execute; the payload matches nothing, so
    // zero rows — NOT the whole table (which OR 1=1 would have returned).
    const res = await trpc<{ rows: Array<Record<string, unknown>> }>(
      app.baseUrl,
      alice,
      "chart.data",
      { chartId: created.chart.id },
    );
    expect(res.rows.length).toBe(0);
  });

  it("rejects stacked statements and schema probes through the AST gate", async () => {
    const created = await trpc<{ chart: { id: string } }>(
      app.baseUrl,
      alice,
      "chart.create",
      { datasetId, spec: baseSpec("north'); DROP TABLE datasets.ds_x; --") },
      "mutation",
    );
    // Either the escaped literal runs as a harmless filter (empty result) or
    // the payload is rejected outright — both are safe. What must NOT happen
    // is the statement executing as SQL.
    let rows: Array<Record<string, unknown>> = [];
    let rejected = false;
    try {
      const res = await trpc<{ rows: Array<Record<string, unknown>> }>(
        app.baseUrl,
        alice,
        "chart.data",
        { chartId: created.chart.id },
      );
      rows = res.rows;
    } catch {
      rejected = true;
    }
    expect(rows.length === 0 || rejected).toBe(true);
    // The dataset table survived (no DROP happened).
    const ds = (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as {
      dataset: { status: string };
    };
    expect(ds.dataset.status).toBe("ready");
  });
});
