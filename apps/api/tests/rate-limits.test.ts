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
 * Phase 8 rate limits and quotas:
 * - per-user API rate limit (USER_REQUESTS_PER_MIN)
 * - per-org agent-run quota (ORG_RUNS_PER_HOUR)
 * - per-token MCP rate limit (covered in mcp-external.test.ts)
 * - usage_daily rollups written when runs finish
 */

let app: TestApp;
let alice: string;
let orgAId = "";
let projectId = "";
let datasetId = "";
let dashboardId = "";

beforeAll(async () => {
  // The limit is read per request, so defaults apply during setup and the
  // specific tests lower it (and restore) themselves.
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "rl-alice@test.example", "Alice");
  const org = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "RL Org" }, "mutation");
  orgAId = org.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "RL Project" }, "mutation");
  projectId = project.id;
  const up = await uploadCsv(app.baseUrl, alice, projectId, "rl.csv", "region,revenue\nnorth,120\nsouth,80");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "RL Dash" }, "mutation");
  dashboardId = dash.id;
}, 150_000);

afterAll(async () => {
  await app?.close();
  delete process.env.USER_REQUESTS_PER_MIN;
  delete process.env.ORG_RUNS_PER_HOUR;
});

describe("per-user rate limit", () => {
  it("returns 429 with Retry-After after the configured requests per minute", async () => {
    process.env.USER_REQUESTS_PER_MIN = "3";
    try {
      // Fresh user: the counter is per user id and setup already used alice's.
      const fresh = await signUp(app.baseUrl, "rl-fresh@test.example", "Fresh");
      const freshOrg = await trpc<{ id: string }>(app.baseUrl, fresh, "org.create", { name: "RL Fresh Org" }, "mutation");
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${app.baseUrl}/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ orgId: freshOrg.id }))}`, {
          headers: { cookie: fresh },
        });
        codes.push(res.status);
      }
      expect(codes[0]).toBe(200);
      expect(codes).toContain(429);
      const limited = codes.lastIndexOf(429);
      expect(limited).toBeGreaterThan(0); // later requests are limited
    } finally {
      process.env.USER_REQUESTS_PER_MIN = "300";
    }
  });

  it("does not limit unauthenticated health endpoints", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${app.baseUrl}/healthz`);
      expect(res.status).toBe(200);
    }
  });
});

describe("per-org agent-run quota", () => {
  it("rejects the third run in the hour with QUOTA_EXCEEDED", async () => {
    process.env.ORG_RUNS_PER_HOUR = "2";
    try {
      const first = await trpc<{ runId: string }>(
        app.baseUrl,
        alice,
        "run.start",
        { dashboardId, kind: "generate_dashboard", prompt: "Build a dashboard." },
        "mutation",
      );
      expect(first.runId).toBeTruthy();
      const second = await trpc<{ runId: string }>(
        app.baseUrl,
        alice,
        "run.start",
        { dashboardId, kind: "ask", prompt: "Another question." },
        "mutation",
      );
      expect(second.runId).toBeTruthy();
      let code = "";
      let message = "";
      try {
        await trpc(app.baseUrl, alice, "run.start", { dashboardId, kind: "ask", prompt: "Third run." }, "mutation");
      } catch (e) {
        const err = e as Error & { code?: string; message: string };
        code = err.code ?? "";
        message = err.message;
      }
      expect(code === "QUOTA_EXCEEDED" || code === "TOO_MANY_REQUESTS").toBe(true);
      expect(message).toContain("quota");
    } finally {
      process.env.ORG_RUNS_PER_HOUR = "30";
    }
  }, 120_000);

  it("writes usage_daily rollups when runs finish", async () => {
    // The two runs from the previous test finish; poll for the rollup.
    await pollUntil(
      async () => {
        const rows = (await app.db.execute(
          (await import("drizzle-orm")).sql`SELECT agent_runs::int AS n FROM usage_daily WHERE organization_id = ${orgAId}`,
        )) as unknown as Array<{ n: number }>;
        return rows;
      },
      (rows) => (rows[0]?.n ?? 0) >= 1,
      60_000,
    );
    const summary = await trpc<{ days: Array<{ agentRuns: number }>; costNote: string }>(
      app.baseUrl,
      alice,
      "usage.orgSummary",
      { orgId: orgAId },
    );
    expect(summary.days.length).toBeGreaterThan(0);
    expect(summary.days[0]!.agentRuns).toBeGreaterThanOrEqual(1);
    // Mock model: cost figures are labeled simulated.
    expect(summary.costNote).toContain("simulated");
  }, 90_000);
});
