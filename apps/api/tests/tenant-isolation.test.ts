import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signInternalContext } from "@graphite/mcp-server/internal-auth";
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
 * Cross-tenant isolation: two organizations with separate users. Every MCP
 * tool and every Socket.IO event must fail closed for a caller from another
 * organization.
 */

let app: TestApp;
let alice: string;
let bob: string;
let bobId = "";
let orgAId = "";
let orgBId = "";
let projectId = "";
let datasetId = "";
let dashboardId = "";
let chartId = "";

function connect(baseUrl: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`${baseUrl}/collab`, {
      transports: ["websocket"],
      extraHeaders: { cookie },
      reconnection: false,
      timeout: 5000,
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (e) => reject(e));
  });
}

function emitAck<T = { ok: boolean; error?: string }>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res));
  });
}

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "iso-alice@test.example", "Alice");
  bob = await signUp(app.baseUrl, "iso-bob@test.example", "Bob");
  const orgA = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "Iso Org A" }, "mutation");
  orgAId = orgA.id;
  const orgB = await trpc<{ id: string }>(app.baseUrl, bob, "org.create", { name: "Iso Org B" }, "mutation");
  orgBId = orgB.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "Iso Project" }, "mutation");
  projectId = project.id;
  const membersB = await trpc<Array<{ userId: string; email: string }>>(app.baseUrl, bob, "member.list", { orgId: orgBId });
  bobId = membersB.find((m) => m.email === "iso-bob@test.example")!.userId;

  const up = await uploadCsv(app.baseUrl, alice, projectId, "iso.csv", "region,revenue\nnorth,120\nsouth,80");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "Iso Dash" }, "mutation");
  dashboardId = dash.id;
  const spec = {
    version: 1,
    type: "bar",
    title: "Iso chart",
    datasetId,
    query: { select: [{ field: "region" }], limit: 50 },
    encoding: { x: { field: "region", type: "category" as const } },
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

async function withBobClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const { context, signature } = signInternalContext(
    { userId: bobId, orgId: orgBId, requestId: `iso_${crypto.randomUUID()}` },
    app.mcpSecret,
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpPort}/mcp`), {
    requestInit: {
      headers: {
        "x-graphite-internal-context": context,
        "x-graphite-internal-signature": signature,
      },
    },
  });
  const client = new Client({ name: "iso-test-client", version: "1.0.0" }, {});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
  if (!res.isError) throw new Error(`expected ${name} to fail cross-tenant, got: ${text}`);
  return text;
}

const SPEC = () => ({
  version: 1,
  type: "bar",
  title: "Cross-tenant attempt",
  datasetId,
  query: { select: [{ field: "region" }], limit: 50 },
  encoding: { x: { field: "region", type: "category" as const } },
  style: { palette: "graphite" as const, legend: false, stack: false },
});

describe("MCP tools: cross-tenant access fails (org B identity vs org A resources)", () => {
  it("list_projects returns only the caller's org", async () => {
    await withBobClient(async (c) => {
      const res = await c.callTool({ name: "list_projects", arguments: {} });
      expect(res.isError).toBeFalsy();
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).not.toContain(projectId);
    });
  });

  it("list_datasets and list_dashboards return nothing for another org's project", async () => {
    await withBobClient(async (c) => {
      const ds = await c.callTool({ name: "list_datasets", arguments: { projectId } });
      expect((ds.content as Array<{ text: string }>)[0]?.text).toContain('"datasets":[]');
      const db = await c.callTool({ name: "list_dashboards", arguments: { projectId } });
      expect((db.content as Array<{ text: string }>)[0]?.text).toContain('"dashboards":[]');
    });
  });

  it("describe_dataset, sample_rows, and run_sql fail with NOT_FOUND", async () => {
    await withBobClient(async (c) => {
      expect(await callTool(c, "describe_dataset", { datasetId })).toContain("Dataset not found");
      expect(await callTool(c, "sample_rows", { datasetId, limit: 5 })).toContain("Dataset not found");
      expect(await callTool(c, "run_sql", { datasetId, sql: "SELECT * FROM region" })).toContain(
        "Dataset not found",
      );
    });
  });

  it("list_charts fails with NOT_FOUND", async () => {
    await withBobClient(async (c) => {
      expect(await callTool(c, "list_charts", { dashboardId })).toContain("Dashboard not found");
    });
  });

  it("create_chart_spec fails and creates nothing", async () => {
    const before = await app.db.execute(
      (await import("drizzle-orm")).sql`SELECT count(*)::int AS n FROM charts`,
    ) as unknown as Array<{ n: number }>;
    await withBobClient(async (c) => {
      const text = await callTool(c, "create_chart_spec", { spec: SPEC(), dashboardId });
      expect(text).toContain("Dataset not found");
    });
    const after = await app.db.execute(
      (await import("drizzle-orm")).sql`SELECT count(*)::int AS n FROM charts`,
    ) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(before[0]?.n); // no side effect
  });

  it("update_chart_spec fails with NOT_FOUND", async () => {
    await withBobClient(async (c) => {
      expect(await callTool(c, "update_chart_spec", { chartId, spec: SPEC() })).toContain(
        "Chart not found",
      );
    });
  });

  it("add_chart_to_dashboard fails with NOT_FOUND", async () => {
    await withBobClient(async (c) => {
      expect(await callTool(c, "add_chart_to_dashboard", { dashboardId, chartId })).toContain(
        "Dashboard not found",
      );
    });
  });
});

describe("Socket.IO: cross-tenant events fail closed", () => {
  it("dashboard:join is rejected for a non-member", async () => {
    const sock = await connect(app.baseUrl, bob);
    try {
      const res = await emitAck(sock, "dashboard:join", { dashboardId });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("NOT_FOUND");
    } finally {
      sock.disconnect();
    }
  });

  it("layout:save is rejected for a non-member and the layout is unchanged", async () => {
    const sock = await connect(app.baseUrl, bob);
    try {
      const res = await emitAck(sock, "layout:save", {
        dashboardId,
        baseVersion: 1,
        items: [{ chartId, x: 5, y: 5, w: 6, h: 4, z: 0 }],
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("NOT_FOUND");
      const dash = await trpc<{ dashboard: { layoutVersion: number } }>(app.baseUrl, alice, "dashboard.get", { dashboardId });
      expect(dash.dashboard.layoutVersion).toBe(1);
    } finally {
      sock.disconnect();
    }
  });

  it("presence, cursor, and drag relays from a non-joined socket never reach the room", async () => {
    const aliceSock = await connect(app.baseUrl, alice);
    const bobSock = await connect(app.baseUrl, bob);
    try {
      const joined = await emitAck(aliceSock, "dashboard:join", { dashboardId });
      expect(joined.ok).toBe(true);

      // Bob (org B) never joined this dashboard. Nothing he emits may reach it.
      bobSock.emit("presence:update", { dashboardId, selectedChartId: chartId });
      bobSock.emit("cursor:move", { dashboardId, x: 111, y: 222 });
      bobSock.emit("chart:drag", { dashboardId, chartId, x: 1, y: 1, state: "start" });

      // Alice must not receive any event provoked by Bob. Wait out the relay
      // window; any arrival fails the test.
      const intruded = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("none"), 1200);
        const done = (name: string) => {
          clearTimeout(timer);
          resolve(name);
        };
        aliceSock.once("cursor:update", () => done("cursor:update"));
        aliceSock.once("chart:drag", () => done("chart:drag"));
        aliceSock.once("presence:state", (u: { users?: Array<{ userId: string }> }) => {
          if (u.users?.some((x) => x.userId === bobId)) done("presence:state");
        });
      });
      expect(intruded).toBe("none");

      // Sanity: Alice's own cursor still relays to herself? No — relays skip
      // the sender; verify the channel works by having Alice update presence
      // and observing it reflected via the room.
      aliceSock.emit("presence:update", { dashboardId });
      await new Promise((r) => setTimeout(r, 200));
      const presence = await app.redis.hvals(`presence:${dashboardId}`);
      expect(presence.length).toBe(1); // only Alice in the room hash
    } finally {
      aliceSock.disconnect();
      bobSock.disconnect();
    }
  });
});
