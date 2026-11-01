import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signUp, rest, startTestApp, trpc, uploadCsv, pollUntil, type TestApp } from "./helpers.js";

/**
 * Phase 7: external MCP over Streamable HTTP at /mcp with personal access
 * tokens — token lifecycle, scopes, revocation, rate limits, client tracking,
 * audit entries, and live dashboard events.
 */

let app: TestApp;
let alice: string;
let orgAId = "";
let projectId = "";
let datasetId = "";
let dashboardId = "";
let fullToken = "";
let roToken = "";

const SPEC = (title: string) => ({
  version: 1,
  type: "bar",
  title,
  datasetId,
  query: { select: [{ field: "region" }, { field: "revenue", agg: "sum", as: "total_revenue" }], groupBy: ["region"], limit: 50 },
  encoding: { x: { field: "region", type: "category" as const }, y: { field: "total_revenue", type: "number" as const } },
  style: { palette: "graphite" as const, legend: false, stack: false },
});

async function withTokenClient<T>(
  token: string,
  fn: (c: Client) => Promise<T>,
  clientName = "graphite-scripted-client",
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: clientName, version: "1.2.3" }, {});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function toolText(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await c.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: (res.content as Array<{ text: string }>)[0]?.text ?? "",
  };
}

function connectSocket(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${app.baseUrl}/collab`, {
      transports: ["websocket"],
      extraHeaders: { cookie },
      reconnection: false,
      timeout: 5000,
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => reject(e));
  });
}

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "ext-mcp-alice@test.example", "Alice");
  const org = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "Ext Org" }, "mutation");
  orgAId = org.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "Ext Project" }, "mutation");
  projectId = project.id;
  const up = await uploadCsv(app.baseUrl, alice, projectId, "ext.csv", "region,revenue\nnorth,120\nsouth,80\neast,60");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "Ext Dash" }, "mutation");
  dashboardId = dash.id;

  // Tokens via the REST endpoints (as a client would).
  const created = await rest(app.baseUrl, alice, "POST", `/api/v1/orgs/${orgAId}/mcp/tokens`, {
    name: "Claude Desktop",
    scopes: ["datasets:read", "charts:read", "charts:write"],
    expiresInDays: 30,
  });
  expect(created.status).toBe(201);
  const body = created.json as { token: string; prefix: string; id: string };
  expect(body.token).toMatch(/^gph_live_/);
  expect(body.prefix.length).toBeLessThan(body.token.length);
  fullToken = body.token;
  fullTokenId = body.id;

  const ro = await rest(app.baseUrl, alice, "POST", `/api/v1/orgs/${orgAId}/mcp/tokens`, {
    name: "Read-only client",
    scopes: ["datasets:read", "charts:read"],
  });
  roToken = (ro.json as { token: string }).token;
}, 150_000);

let fullTokenId = "";

afterAll(async () => {
  await app?.close();
});

describe("token lifecycle (REST)", () => {
  it("lists tokens with prefixes but never the plaintext or hash", async () => {
    const res = await rest(app.baseUrl, alice, "GET", `/api/v1/orgs/${orgAId}/mcp/tokens`);
    const tokens = (res.json as { tokens: Array<{ prefix: string; scopes: string[]; tokenHash?: string; token?: string }> }).tokens;
    expect(tokens.length).toBe(2);
    for (const t of tokens) {
      expect(t.prefix).toMatch(/^gph_live_/);
      expect(t.token).toBeUndefined();
      expect(t.tokenHash).toBeUndefined();
    }
  });

  it("rejects unauthenticated token management", async () => {
    const res = await fetch(`${app.baseUrl}/api/v1/orgs/${orgAId}/mcp/tokens`);
    expect(res.status).toBe(401);
  });
});

describe("external MCP client over /mcp", () => {
  it("a scripted MCP client creates a chart and places it; the open dashboard receives live events", async () => {
    const sock = await connectSocket(alice);
    const joinRes = await new Promise<{ ok: boolean }>((resolve) => {
      sock.emit("dashboard:join", { dashboardId }, (r: { ok: boolean }) => resolve(r));
    });
    expect(joinRes.ok).toBe(true);

    const versionEvent = new Promise<Record<string, unknown>>((resolve) => {
      sock.once("chart:version-created", (d: Record<string, unknown>) => resolve(d));
    });
    const addedEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no chart:added event")), 15_000);
      sock.once("chart:added", (d: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(d);
      });
    });

    await withTokenClient(fullToken, async (c) => {
      // initialize (connect) already tracked the client.
      const created = await toolText(c, "create_chart_spec", { spec: SPEC("External chart"), dashboardId });
      expect(created.isError).toBe(false);
      const out = JSON.parse(created.text) as { chartId: string; version: number };
      expect(out.version).toBe(1);

      const ev = (await versionEvent) as { chartId: string; version: number; source: string };
      expect(ev.chartId).toBe(out.chartId);
      expect(ev.source).toBe("mcp");

      // A standalone chart, then placed on the dashboard.
      const standalone = await toolText(c, "create_chart_spec", { spec: SPEC("Standalone chart") });
      const standaloneOut = JSON.parse(standalone.text) as { chartId: string };
      const placed = await toolText(c, "add_chart_to_dashboard", {
        dashboardId,
        chartId: standaloneOut.chartId,
        position: { x: 6, y: 0, w: 6, h: 4 },
      });
      expect(placed.isError).toBe(false);
    });

    const added = (await addedEvent) as { chartId: string };
    expect(added.chartId).toBeTruthy();
    sock.disconnect();

    // The dashboard shows both charts with source "mcp" and version 1.
    const view = await trpc<{ charts: Array<{ chart: { title: string }; version: { versionNumber: number; source: string } }> }>(
      app.baseUrl,
      alice,
      "dashboard.get",
      { dashboardId },
    );
    const titles = view.charts.map((ch) => ch.chart.title);
    expect(titles).toContain("External chart");
    expect(titles).toContain("Standalone chart");
    for (const ch of view.charts) {
      expect(ch.version.source).toBe("mcp");
      expect(ch.version.versionNumber).toBe(1);
    }
  }, 60_000);

  it("tracks the connected client from initialize info", async () => {
    const res = await rest(app.baseUrl, alice, "GET", `/api/v1/orgs/${orgAId}/mcp/clients`);
    const clients = (res.json as { clients: Array<{ clientName: string; clientVersion: string | null }> }).clients;
    expect(clients.length).toBeGreaterThan(0);
    expect(clients.some((c) => c.clientName === "graphite-scripted-client")).toBe(true);
  });

  it("write tools write audit entries with actor_type mcp", async () => {
    const rows = (await app.db.execute(
      (await import("drizzle-orm")).sql`SELECT actor_type, action FROM audit_logs WHERE actor_type = 'mcp' ORDER BY created_at DESC LIMIT 3`,
    )) as unknown as Array<{ actor_type: string; action: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.action === "chart.create")).toBe(true);
  });

  it("a token without charts:write cannot call write tools but can read", async () => {
    await withTokenClient(roToken, async (c) => {
      const denied = await toolText(c, "create_chart_spec", { spec: SPEC("Should not exist"), dashboardId });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("Missing scope: charts:write");

      const deniedPlacement = await toolText(c, "add_chart_to_dashboard", { dashboardId, chartId: "chart_x" });
      expect(deniedPlacement.isError).toBe(true);
      expect(deniedPlacement.text).toContain("Missing scope: charts:write");

      // Reads still work.
      const described = await toolText(c, "describe_dataset", { datasetId });
      expect(described.isError).toBe(false);
      expect(described.text).toContain("region");
    });
    // Nothing was created.
    const view = await trpc<{ charts: Array<{ chart: { title: string } }> }>(app.baseUrl, alice, "dashboard.get", { dashboardId });
    expect(view.charts.every((ch) => ch.chart.title !== "Should not exist")).toBe(true);
  });

  it("a revoked token is rejected on the very next request", async () => {
    const res = await rest(app.baseUrl, alice, "POST", `/api/v1/orgs/${orgAId}/mcp/tokens`, {
      name: "Short-lived",
      scopes: ["datasets:read"],
    });
    const { token, id } = res.json as { token: string; id: string };
    await withTokenClient(token, async (c) => {
      const ok = await toolText(c, "list_projects", {});
      expect(ok.isError).toBe(false);
    });
    await rest(app.baseUrl, alice, "DELETE", `/api/v1/orgs/${orgAId}/mcp/tokens/${id}`);
    // Very next request must fail with 401.
    const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "revoked", version: "1.0.0" }, {});
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("an expired token is rejected", async () => {
    const res = await rest(app.baseUrl, alice, "POST", `/api/v1/orgs/${orgAId}/mcp/tokens`, {
      name: "Expired",
      scopes: ["datasets:read"],
      expiresInDays: 1,
    });
    const { token, id } = res.json as { token: string; id: string };
    await app.db.execute(
      (await import("drizzle-orm")).sql`UPDATE mcp_tokens SET expires_at = now() - interval '1 hour' WHERE id = ${id}`,
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${app.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "expired", version: "1.0.0" }, {});
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("enforces the per-token rate limit with Retry-After", async () => {
    // Pre-fill the fixed-window counter to the limit.
    await app.redis.set(`rl:mcp-token:${fullTokenId}`, "120");
    const res = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${fullToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
