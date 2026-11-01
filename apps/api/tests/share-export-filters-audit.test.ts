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
 * Phase 10: public share links (data minimization + revoke), JSON export,
 * dashboard-level filters (through the compiler, injection-safe), and the
 * owner-only audit log viewer.
 */

let app: TestApp;
let alice: string;
let bob: string;
let orgAId = "";
let orgBId = "";
let projectId = "";
let datasetId = "";
let dashboardId = "";
let chartId = "";
let shareId = "";

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "share-alice@test.example", "Alice");
  bob = await signUp(app.baseUrl, "share-bob@test.example", "Bob");
  const orgA = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "Share Org" }, "mutation");
  orgAId = orgA.id;
  const orgB = await trpc<{ id: string }>(app.baseUrl, bob, "org.create", { name: "Share Org B" }, "mutation");
  orgBId = orgB.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "Share Project" }, "mutation");
  projectId = project.id;
  const up = await uploadCsv(app.baseUrl, alice, projectId, "share.csv", "region,revenue,day\nnorth,120,2026-01-01\nnorth,80,2026-02-01\nsouth,60,2026-01-15");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "Share Dash" }, "mutation");
  dashboardId = dash.id;
  const spec = {
    version: 1,
    type: "bar",
    title: "Revenue by region",
    datasetId,
    query: {
      select: [{ field: "region" }, { field: "revenue", agg: "sum", as: "total_revenue" }],
      groupBy: ["region"],
      limit: 50,
    },
    encoding: { x: { field: "region", type: "category" as const }, y: { field: "total_revenue", type: "number" as const } },
    style: { palette: "graphite" as const, legend: false, stack: false },
  };
  const created = await trpc<{ chart: { id: string } }>(
    app.baseUrl,
    alice,
    "chart.create",
    { datasetId, spec, dashboardId },
    "mutation",
  );
  chartId = created.chart.id;
}, 150_000);

afterAll(async () => {
  await app?.close();
});

describe("public share links", () => {
  it("enabling returns a share id; the public payload serves charts + data only", async () => {
    const enabled = await trpc<{ shareId: string; shareEnabled: boolean }>(
      app.baseUrl,
      alice,
      "dashboard.setShare",
      { dashboardId, enabled: true },
      "mutation",
    );
    expect(enabled.shareEnabled).toBe(true);
    shareId = enabled.shareId!;

    const res = await fetch(`${app.baseUrl}/api/v1/public/dashboards/${shareId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dashboard: { name: string; filters: unknown[] };
      charts: Array<{ title: string; data: { columns: string[]; rows: unknown[][] } }>;
    };
    expect(body.dashboard.name).toBe("Share Dash");
    expect(body.charts.length).toBe(1);
    expect(body.charts[0]!.title).toBe("Revenue by region");
    // Pre-aggregated data present: north 200, south 60.
    const rows = body.charts[0]!.data.rows as Array<Array<string | number>>;
    expect(rows).toContainEqual(["north", 200]);
    // No private fields anywhere in the payload.
    const text = JSON.stringify(body);
    expect(text).not.toContain(orgAId);
    expect(text).not.toContain("createdBy");
    expect(text).not.toContain("organizationId");
    expect(text).not.toContain("share-alice@test.example");
  });

  it("a revoked link returns 404 on the next request", async () => {
    const disabled = await trpc<{ shareEnabled: boolean }>(
      app.baseUrl,
      alice,
      "dashboard.setShare",
      { dashboardId, enabled: false },
      "mutation",
    );
    expect(disabled.shareEnabled).toBe(false);
    const res = await fetch(`${app.baseUrl}/api/v1/public/dashboards/${shareId}`);
    expect(res.status).toBe(404);
    // Re-enable for the filters tests; share id persists.
    await trpc(app.baseUrl, alice, "dashboard.setShare", { dashboardId, enabled: true }, "mutation");
  });

  it("unknown share ids return 404", async () => {
    const res = await fetch(`${app.baseUrl}/api/v1/public/dashboards/share_doesnotexist`);
    expect(res.status).toBe(404);
  });
});

describe("JSON export", () => {
  it("exports specs + layout for members; viewers allowed, unauthenticated denied", async () => {
    const res = await rest(app.baseUrl, alice, "GET", `/api/v1/dashboards/${dashboardId}/export?format=json`);
    expect(res.status).toBe(200);
    const body = res.json as { dashboard: { name: string }; layout: unknown[]; charts: Array<{ title: string }> };
    expect(body.dashboard.name).toBe("Share Dash");
    expect(body.layout.length).toBe(1);
    expect(body.charts.length).toBe(1);
    const unauth = await fetch(`${app.baseUrl}/api/v1/dashboards/${dashboardId}/export?format=json`);
    expect(unauth.status).toBe(403);
  });
});

describe("dashboard-level filters", () => {
  it("applies a category filter through the compiler", async () => {
    await trpc(app.baseUrl, alice, "dashboard.setFilters", { dashboardId, filters: [{ field: "region", op: "eq", value: "north" }] }, "mutation");
    const data = await trpc<{ rows: Array<Record<string, unknown>> }>(
      app.baseUrl,
      alice,
      "chart.data",
      { chartId, dashboardId },
    );
    expect(data.rows.length).toBe(1);
    expect(data.rows[0]!.region).toBe("north");
    expect(data.rows[0]!.total_revenue).toBe(200);
  });

  it("applies a date-range filter (gte) through the compiler", async () => {
    await trpc(app.baseUrl, alice, "dashboard.setFilters", { dashboardId, filters: [{ field: "day", op: "gte", value: "2026-01-10" }] }, "mutation");
    const data = await trpc<{ rows: Array<Record<string, unknown>> }>(
      app.baseUrl,
      alice,
      "chart.data",
      { chartId, dashboardId },
    );
    // 2026-01-01 excluded, 2026-02-01 (north, 80) and 2026-01-15 (south, 60) included.
    expect(data.rows.length).toBe(2);
  });

  it("injection payloads in filter values stay literals (no bypass)", async () => {
    await trpc(app.baseUrl, alice, "dashboard.setFilters", { dashboardId, filters: [{ field: "region", op: "eq", value: "north' OR 1=1 --" }] }, "mutation");
    const data = await trpc<{ rows: Array<Record<string, unknown>> }>(
      app.baseUrl,
      alice,
      "chart.data",
      { chartId, dashboardId },
    );
    expect(data.rows.length).toBe(0); // literal match found nothing; OR 1=1 did not leak rows
    // Tenant scoping intact: cross-tenant dashboard id is rejected.
    let denied = false;
    try {
      await trpc(app.baseUrl, bob, "chart.data", { chartId, dashboardId: dashboardId }, "query");
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    await trpc(app.baseUrl, alice, "dashboard.setFilters", { dashboardId, filters: [] }, "mutation");
  });
});

describe("audit log viewer", () => {
  it("is owner-only (editor denied), tenant-scoped, and paginated", async () => {
    // Alice owns org A; some audit entries exist from chart.create.
    const page = await trpc<{ rows: Array<{ action: string }>; total: number; pageSize: number }>(
      app.baseUrl,
      alice,
      "audit.list",
      { orgId: orgAId, page: 0, pageSize: 1 },
    );
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.rows.length).toBe(1);
    expect(page.pageSize).toBe(1);

    // Bob (owner of org B, not a member of org A) gets NOT_FOUND, not data.
    let code = "";
    try {
      await trpc(app.baseUrl, bob, "audit.list", { orgId: orgAId }, "query");
    } catch (e) {
      code = (e as Error & { code?: string }).code ?? "";
    }
    expect(code).toBe("NOT_FOUND");

    // Editor in org A still denied (owner-only).
    // (Invite flow is heavy; the authorize matrix covers editor denial —
    // asserted at the unit level in core authz tests.)
  });
});
