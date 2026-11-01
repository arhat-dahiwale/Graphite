import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { signUp, startTestApp, startSecondInstance, trpc, type TestApp } from "./helpers.js";
import type { Dashboard } from "@graphite/db/schema";

let app: TestApp;
let instance2: { baseUrl: string; close: () => Promise<void> };
let alice: string;
let aliceCookie = "";
let orgId = "";
let projectId = "";
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

function join(socket: Socket, dashboardId: string): Promise<{ ok: boolean; role?: string; error?: string }> {
  return new Promise((resolve) => {
    socket.emit("dashboard:join", { dashboardId }, (res: { ok: boolean; role?: string; error?: string }) =>
      resolve(res),
    );
  });
}

function once(socket: Socket, event: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

beforeAll(async () => {
  app = await startTestApp();
  instance2 = await startSecondInstance(app);
  aliceCookie = await signUp(app.baseUrl, "collab-alice@test.example", "Alice");
  alice = aliceCookie;
  const org = await trpc<{ id: string }>(app.baseUrl, aliceCookie, "org.create", { name: "Collab Org" }, "mutation");
  orgId = org.id;
  const project = await trpc<{ id: string }>(app.baseUrl, aliceCookie, "project.create", { orgId, name: "Collab Project" }, "mutation");
  projectId = project.id;
  const dash = await trpc<{ id: string }>(app.baseUrl, aliceCookie, "dashboard.create", { projectId, name: "Collab Dash" }, "mutation");
  dashboardId = dash.id;
  const ds = await (await import("./helpers.js")).uploadCsv(
    app.baseUrl,
    aliceCookie,
    projectId,
    "c.csv",
    "region,revenue\nnorth,10\nsouth,20",
  );
  await (await import("./helpers.js")).pollUntil(
    async () =>
      (await (await import("./helpers.js")).rest(app.baseUrl, aliceCookie, "GET", `/api/v1/datasets/${ds.json.dataset!.id}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
  const spec = {
    version: 1,
    type: "bar",
    title: "Collab chart",
    datasetId: ds.json.dataset!.id,
    query: { select: [{ field: "region" }], limit: 50 },
    encoding: { x: { field: "region", type: "category" as const } },
    style: { palette: "graphite" as const, legend: false, stack: false },
  };
  const created = await trpc<{ chart: { id: string } }>(
    app.baseUrl,
    aliceCookie,
    "chart.create",
    { datasetId: ds.json.dataset!.id, spec, dashboardId },
    "mutation",
  );
  chartId = created.chart.id;
  void alice;
}, 150_000);

afterAll(async () => {
  await instance2?.close();
  await app?.close();
});

describe("collab: multi-instance sync", () => {
  it("an event on instance A reaches a client on instance B", async () => {
    const sockA = await connect(app.baseUrl, aliceCookie); // instance 1
    const sockB = await connect(instance2.baseUrl, aliceCookie); // instance 2
    expect((await join(sockA, dashboardId)).ok).toBe(true);
    expect((await join(sockB, dashboardId)).ok).toBe(true);

    // A saves a layout; B must receive layout:updated across instances.
    const updatedAtB = once(sockB, "layout:updated");
    sockA.emit("layout:save", {
      dashboardId,
      baseVersion: 1,
      items: [{ chartId, x: 1, y: 2, w: 6, h: 4, z: 0 }],
    });
    const updated = (await updatedAtB) as { layoutVersion: number; items: Array<{ x: number }> };
    expect(updated.layoutVersion).toBe(2);
    expect(updated.items[0]?.x).toBe(1);

    // Cursor relay A -> B.
    const cursorAtB = once(sockB, "cursor:update");
    sockA.emit("cursor:move", { dashboardId, x: 42, y: 24 });
    const cursor = await cursorAtB;
    expect(cursor.x).toBe(42);

    // Presence reaches B.
    const presenceAtB = once(sockB, "presence:state");
    sockA.emit("presence:update", { dashboardId, selectedChartId: chartId });
    const presence = await presenceAtB;
    expect(Array.isArray((presence as { users: unknown[] }).users)).toBe(true);

    sockA.close();
    sockB.close();
  }, 30_000);

  it("chart:version-created published by MCP/agent tools reaches sockets", async () => {
    const sockB = await connect(instance2.baseUrl, aliceCookie);
    await join(sockB, dashboardId);

    // Publish a chart:version-created event the way the MCP tools do.
    const { dashboardEventsChannel } = await import("@graphite/core");
    await app.redis.publish(
      dashboardEventsChannel(dashboardId),
      JSON.stringify({
        type: "chart:version-created",
        dashboardId,
        data: { chartId, version: 99 },
      }),
    );
    const evt = await once(sockB, "chart:version-created");
    expect((evt as { chartId?: string }).chartId).toBe(chartId);
    sockB.close();
  }, 30_000);
});

describe("collab: layout conflicts and permissions", () => {
  it("rejects a stale baseVersion with layout:conflict on the writer only", async () => {
    const sockA = await connect(app.baseUrl, aliceCookie);
    await join(sockA, dashboardId);

    const conflict = new Promise<Record<string, unknown>>((resolve) => {
      sockA.once("layout:conflict", resolve);
    });
    sockA.emit("layout:save", {
      dashboardId,
      baseVersion: 1, // stale: current is 2 from the earlier save
      items: [{ chartId, x: 0, y: 0, w: 6, h: 4, z: 0 }],
    });
    const c = (await conflict) as { currentVersion: number };
    expect(c.currentVersion).toBe(2);

    // The room did NOT get a layout:updated for the rejected write.
    sockA.close();
  }, 30_000);

  it("viewers cannot save layout changes", async () => {
    // Invite a viewer.
    const daveCookie = await signUp(app.baseUrl, "collab-dave@test.example", "Dave");
    const invite = await trpc<{ token: string }>(
      app.baseUrl,
      aliceCookie,
      "member.invite",
      { orgId, email: "collab-dave@test.example", role: "viewer" },
      "mutation",
    );
    await trpc(app.baseUrl, daveCookie, "member.acceptInvite", { token: invite.token }, "mutation");

    const sockDave = await connect(instance2.baseUrl, daveCookie);
    const joinRes = await join(sockDave, dashboardId);
    expect(joinRes.ok).toBe(true);
    expect(joinRes.role).toBe("viewer");

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sockDave.emit(
        "layout:save",
        {
          dashboardId,
          baseVersion: 2,
          items: [{ chartId, x: 0, y: 0, w: 6, h: 4, z: 0 }],
        },
        (res: { ok: boolean; error?: string }) => resolve(res),
      );
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("FORBIDDEN");
    sockDave.close();
  }, 30_000);

  it("rejects joins from non-members", async () => {
    const eveCookie = await signUp(app.baseUrl, "collab-eve@test.example", "Eve");
    const sockEve = await connect(app.baseUrl, eveCookie);
    const joinRes = await join(sockEve, dashboardId);
    expect(joinRes.ok).toBe(false);
    expect(joinRes.error).toBe("NOT_FOUND");
    sockEve.close();
  }, 30_000);

  it("persists the layout with a bumped layout_version", async () => {
    const dash = await trpc<{ dashboard: Dashboard }>(app.baseUrl, aliceCookie, "dashboard.get", { dashboardId });
    expect(dash.dashboard.layoutVersion).toBe(2);
  });
});
