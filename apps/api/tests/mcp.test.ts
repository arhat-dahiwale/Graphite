import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signInternalContext } from "@graphite/mcp-server/internal-auth";
import { pollUntil, rest, signUp, startTestApp, trpc, uploadCsv, type TestApp } from "./helpers.js";

let app: TestApp;
let alice: string;
let aliceId = "";
let bob: string;
let orgAId = "";
let orgBId = "";
let projectId = "";
let datasetId = "";

beforeAll(async () => {
  app = await startTestApp();
  alice = await signUp(app.baseUrl, "mcp-alice@test.example", "Alice");
  bob = await signUp(app.baseUrl, "mcp-bob@test.example", "Bob");
  const orgA = await trpc<{ id: string }>(app.baseUrl, alice, "org.create", { name: "MCP Org A" }, "mutation");
  orgAId = orgA.id;
  const orgB = await trpc<{ id: string }>(app.baseUrl, bob, "org.create", { name: "MCP Org B" }, "mutation");
  orgBId = orgB.id;
  const project = await trpc<{ id: string }>(app.baseUrl, alice, "project.create", { orgId: orgAId, name: "MCP Project" }, "mutation");
  projectId = project.id;
  // Real user ids for signed identities (FKs require them).
  const members = await trpc<Array<{ userId: string; email: string }>>(app.baseUrl, alice, "member.list", { orgId: orgAId });
  aliceId = members.find((m) => m.email === "mcp-alice@test.example")!.userId;
  const up = await uploadCsv(app.baseUrl, alice, projectId, "mcp.csv", "region,revenue\nnorth,120\nsouth,80");
  datasetId = up.json.dataset!.id;
  await pollUntil(
    async () => (await rest(app.baseUrl, alice, "GET", `/api/v1/datasets/${datasetId}`)).json as { dataset: { status: string } },
    (v) => v.dataset.status === "ready",
    30_000,
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
});

async function withSignedClient<T>(
  identity: { userId: string; orgId: string; requestId?: string },
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const { context, signature } = signInternalContext(
    {
      userId: identity.userId,
      orgId: identity.orgId,
      requestId: identity.requestId ?? `mcp_test_${crypto.randomUUID()}`,
    },
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
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, {});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("MCP server (protocol level)", () => {
  it("exposes all ten tools and executes reads with the signed identity", async () => {
    await withSignedClient({ userId: aliceId, orgId: orgAId }, async (c) => {
      const tools = await c.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "add_chart_to_dashboard",
        "create_chart_spec",
        "describe_dataset",
        "list_charts",
        "list_dashboards",
        "list_datasets",
        "list_projects",
        "run_sql",
        "sample_rows",
        "update_chart_spec",
      ]);

      const described = await c.callTool({ name: "describe_dataset", arguments: { datasetId } });
      const text = (described.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("region");
      expect(text).toContain("revenue");
    });
  });

  it("rejects a tampered internal signature", async () => {
    const { context, signature } = signInternalContext(
      { userId: "u_alice", orgId: orgAId, requestId: "req_tamper" },
      app.mcpSecret,
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpPort}/mcp`), {
      requestInit: {
        headers: {
          "x-graphite-internal-context": context,
          "x-graphite-internal-signature": signature.slice(0, -2) + "xx",
        },
      },
    });
    const client = new Client({ name: "tamper", version: "1.0.0" }, {});
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("enforces tenant isolation inside tools", async () => {
    // Bob's signed identity cannot resolve Alice's dataset.
    await withSignedClient({ userId: "u_bob", orgId: orgBId }, async (c) => {
      const res = await c.callTool({ name: "describe_dataset", arguments: { datasetId } });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("Dataset not found");
    });
  });

  it("write tools write audit entries with actor_type agent/mcp", async () => {
    // Alice creates a chart via MCP directly (no run).
    const spec = {
      version: 1,
      type: "bar",
      title: "MCP chart",
      datasetId,
      query: {
        select: [{ field: "region" }, { field: "revenue", agg: "sum", as: "value" }],
        groupBy: ["region"],
        limit: 50,
      },
      encoding: { x: { field: "region", type: "category" }, y: { field: "value", type: "number" } },
      style: { palette: "graphite", legend: false, stack: false },
    };
    await withSignedClient({ userId: aliceId, orgId: orgAId, requestId: `mcp_audit_${Date.now()}` }, async (c) => {
      const res = await c.callTool({ name: "create_chart_spec", arguments: { spec } });
      expect(res.isError).toBeFalsy();
    });
    const rows = (await app.db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`SELECT action, actor_type FROM audit_logs WHERE resource_type = 'chart' ORDER BY created_at DESC LIMIT 5`,
    )) as unknown as Array<{ action: string; actor_type: string }>;
    expect(rows[0]?.action).toBe("chart.create");
    expect(["agent", "mcp"]).toContain(rows[0]?.actor_type);
  });
});

describe("agent runs pass through MCP", () => {
  it("agent-created charts carry the run identity and audit trail", async () => {
    const dash = await trpc<{ id: string }>(app.baseUrl, alice, "dashboard.create", { projectId, name: "MCP Run Dash" }, "mutation");
    const started = await trpc<{ runId: string }>(
      app.baseUrl,
      alice,
      "run.start",
      { dashboardId: dash.id, kind: "generate_dashboard", prompt: "Build a dashboard." },
      "mutation",
    );
    await pollUntil(
      async () => trpc<{ run: { status: string } }>(app.baseUrl, alice, "run.get", { runId: started.runId }),
      (v) => ["succeeded", "failed", "cancelled"].includes(v.run.status),
      60_000,
      100,
    );
    // Charts created by the run are owned by the run's user (identity propagated).
    const dashView = await trpc<{ charts: Array<{ chart: { createdBy: string } }> }>(
      app.baseUrl,
      alice,
      "dashboard.get",
      { dashboardId: dash.id },
    );
    expect(dashView.charts.length).toBe(3);
    for (const c of dashView.charts) {
      // Identity propagated: charts are owned by the run's user.
      expect(c.chart.createdBy).toBe(aliceId);
    }
    // The audit trail for those charts says actor_type = agent with the runId.
    const rows = (await app.db.execute(
      (await import("drizzle-orm")).sql`SELECT actor_type, metadata FROM audit_logs WHERE action = 'chart.create' ORDER BY created_at DESC LIMIT 3`,
    )) as unknown as Array<{ actor_type: string; metadata: { runId?: string } }>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.actor_type).toBe("agent");
      expect(r.metadata?.runId).toBe(started.runId);
    }
  }, 90_000);
});
