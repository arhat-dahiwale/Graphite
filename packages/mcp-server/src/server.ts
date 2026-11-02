import { Router, type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import type Redis from "ioredis";
import type { DataClient } from "@graphite/data/client";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { mcpTokens } from "@graphite/db/schema";
import { childLogger } from "@graphite/core";
import type { ToolContext } from "./context.js";
import { verifyInternalContext, type InternalContext } from "./internal-auth.js";
import {
  addChartToDashboard,
  addChartToDashboardInput,
  createChartSpec,
  createChartSpecInput,
  describeDataset,
  describeDatasetInput,
  listCharts,
  listChartsInput,
  listDashboards,
  listDashboardsInput,
  listDatasets,
  listDatasetsInput,
  listProjects,
  listProjectsInput,
  runSql,
  runSqlInput,
  sampleRows,
  sampleRowsInput,
  updateChartSpec,
  updateChartSpecInput,
} from "./tools/index.js";

const log = childLogger({ component: "mcp-server" });

export interface McpRouterDeps {
  db: Database;
  sql: Sql;
  redis: Redis;
  getDataClient: () => DataClient;
  secret: string;
}

interface ResolvedIdentity {
  actor: ToolContext["actor"];
  agentRunId?: string;
  defaultDashboardId?: string;
  requestId: string;
}

async function resolveIdentity(deps: McpRouterDeps, req: Request): Promise<ResolvedIdentity> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer gph_live_")) {
    // External MCP client (personal access token, Phase 7 UI): token is shown
    // once and stored hashed.
    const token = auth.slice("Bearer ".length);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const rows = await deps.db
      .select()
      .from(mcpTokens)
      .where(and(eq(mcpTokens.tokenHash, tokenHash), isNull(mcpTokens.revokedAt)))
      .limit(1);
    const t = rows[0];
    if (!t || (t.expiresAt !== null && t.expiresAt.getTime() < Date.now())) {
      throw Object.assign(new Error("Invalid or expired token"), { status: 401 });
    }
    await deps.db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, t.id));
    return {
      actor: { userId: t.userId, orgId: t.organizationId, role: "editor" },
      requestId: `mcp_${crypto.randomUUID()}`,
    };
  }
  // Internal agent identity (signed, cannot be forged without the secret).
  const internal = verifyInternalContext(
    req.headers["x-graphite-internal-context"] as string | undefined,
    req.headers["x-graphite-internal-signature"] as string | undefined,
    deps.secret,
  );
  return toIdentity(internal);
}

function toIdentity(ctx: InternalContext): ResolvedIdentity {
  return {
    actor: { userId: ctx.userId, orgId: ctx.orgId, role: "editor" },
    agentRunId: ctx.runId,
    defaultDashboardId: ctx.dashboardId,
    requestId: ctx.requestId,
  };
}

/**
 * Streamable-HTTP MCP server (stateless mode). Every POST creates a fresh
 * McpServer bound to the REQUEST's identity, so authorization and tenant
 * checks inside each tool match the caller exactly.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  const buildServer = (identity: ResolvedIdentity): McpServer => {
    const ctx: ToolContext = {
      db: deps.db,
      sql: deps.sql,
      redis: deps.redis,
      getDataClient: deps.getDataClient,
      actor: identity.actor,
      agentRunId: identity.agentRunId,
      defaultDashboardId: identity.defaultDashboardId,
      requestId: identity.requestId,
    };
    const server = new McpServer(
      { name: "graphite-mcp", version: "0.1.0" },
      { instructions: "Graphite tools: explore datasets and manage charts on dashboards." },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const register = (
      name: string,
      description: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: { shape: any },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (input: any) => Promise<unknown>,
    ): void => {
      server.registerTool(
        name,
        { description, inputSchema: schema.shape },
        async (args: unknown) => {
          try {
            const result = await execute(args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (e) {
            const message = e instanceof Error ? e.message : "Tool execution failed";
            log.warn({ tool: name, err: message }, "tool error surfaced to model");
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
              isError: true,
            };
          }
        },
      );
    };

    register(
      "list_projects",
      "List projects in your organization.",
      listProjectsInput,
      (input) => listProjects(ctx, input),
    );
    register(
      "list_datasets",
      "List datasets in a project with their status and row counts.",
      listDatasetsInput,
      (input) => listDatasets(ctx, input),
    );
    register(
      "list_dashboards",
      "List dashboards in a project.",
      listDashboardsInput,
      (input) => listDashboards(ctx, input),
    );
    register(
      "list_charts",
      "List charts on a dashboard with their current specs and positions.",
      listChartsInput,
      (input) => listCharts(ctx, input),
    );
    register(
      "describe_dataset",
      "Get dataset columns, types, nullability, stats, and row count. Call before writing SQL or chart specs.",
      describeDatasetInput,
      (input) => describeDataset(ctx, input),
    );
    register(
      "sample_rows",
      "Small ordered sample of rows from a dataset (max 20).",
      sampleRowsInput,
      (input) => sampleRows(ctx, input),
    );
    register(
      "run_sql",
      "Run a read-only SELECT against one dataset. Single SELECT only; results capped.",
      runSqlInput,
      (input) => runSql(ctx, input),
    );
    register(
      "create_chart_spec",
      "Validate and store a new chart from a ChartSpec, optionally placing it on the run's dashboard.",
      createChartSpecInput,
      (input) => createChartSpec(ctx, input),
    );
    register(
      "update_chart_spec",
      "Create a new version of an existing chart with a changed ChartSpec.",
      updateChartSpecInput,
      (input) => updateChartSpec(ctx, input),
    );
    register(
      "add_chart_to_dashboard",
      "Place an existing chart on a dashboard.",
      addChartToDashboardInput,
      (input) => addChartToDashboard(ctx, input),
    );

    return server;
  };

  router.post("/mcp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = await resolveIdentity(deps, req);
      const server = buildServer(identity);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 401;
      if (status === 401) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: e instanceof Error ? e.message : "Unauthorized", requestId: "", details: {} },
        });
        return;
      }
      next(e);
    }
  });

  // Stateless mode: no GET (SSE) or DELETE (session teardown) support.
  router.get("/mcp", (_req, res) => {
    res.status(405).json({ error: { code: "BAD_REQUEST", message: "Method not allowed in stateless mode", requestId: "", details: {} } });
  });
  router.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: { code: "BAD_REQUEST", message: "Method not allowed in stateless mode", requestId: "", details: {} } });
  });

  return router;
}
