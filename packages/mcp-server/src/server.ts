import { Router, type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import type Redis from "ioredis";
import type { DataClient } from "@graphite/data/client";
import { eq } from "drizzle-orm";
import { mcpTokens } from "@graphite/db/schema";
import { childLogger, isAppError } from "@graphite/core";
import type { ToolContext } from "./context.js";
import { assertInternalMcpSecret, verifyInternalContext } from "./internal-auth.js";
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
import { actorForUser } from "./context.js";
import {
  checkTokenRateLimit,
  resolveMcpToken,
  trackMcpClient,
} from "./tokens.js";
import { resolveOAuthAccessToken } from "./oauth.js";
import { ALL_SCOPES, TOOL_SCOPES, hasScope, type McpScope } from "./scopes.js";

const log = childLogger({ component: "mcp-server" });

export interface McpRouterDeps {
  db: Database;
  sql: Sql;
  redis: Redis;
  getDataClient: () => DataClient;
  secret: string;
  /** Per-token rate limit (req/min). Default 120 per API.md. */
  tokenRateLimitPerMin?: number;
}

interface ResolvedIdentity {
  actor: ToolContext["actor"];
  /** Scopes granted to this caller (all scopes for the internal agent). */
  scopes: McpScope[];
  tokenId?: string;
  agentRunId?: string;
  defaultDashboardId?: string;
  requestId: string;
}

async function resolveIdentity(deps: McpRouterDeps, req: Request): Promise<ResolvedIdentity> {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer gph_live_")) {
    // External MCP client (personal access token): hashed storage, shown once.
    const token = auth.slice("Bearer ".length);
    const t = await resolveMcpToken(deps.db, token);
    if (!t) {
      throw Object.assign(new Error("Invalid, expired, or revoked token"), { status: 401 });
    }
    // Rate limit before any other work.
    await checkTokenRateLimit(deps.redis, t.id, deps.tokenRateLimitPerMin ?? 120);
    // Real membership role (viewer tokens act as viewers).
    const actor = await actorForUser(deps.db, t.userId, t.organizationId);
    await deps.db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, t.id));
    return {
      actor,
      scopes: t.scopes,
      tokenId: t.id,
      requestId: `mcp_${crypto.randomUUID()}`,
    };
  }
  if (auth?.startsWith("Bearer gphat_")) {
    // OAuth 2.1 access token (Phase 10): same ToolContext, scopes, and org
    // binding as the PAT path.
    const oauth = await resolveOAuthAccessToken(deps.db, auth.slice("Bearer ".length));
    if (!oauth) {
      throw Object.assign(new Error("Invalid, expired, or revoked access token"), { status: 401 });
    }
    const actor = await actorForUser(deps.db, oauth.userId, oauth.organizationId);
    return {
      actor,
      scopes: oauth.scope.split(" ") as McpScope[],
      tokenId: undefined,
      requestId: `mcp_${crypto.randomUUID()}`,
    };
  }
  // Internal agent identity (signed, cannot be forged without the secret).
  const internal = verifyInternalContext(
    req.headers["x-graphite-internal-context"] as string | undefined,
    req.headers["x-graphite-internal-signature"] as string | undefined,
    deps.secret,
  );
  const actor = await actorForUser(deps.db, internal.userId, internal.orgId);
  return {
    actor,
    scopes: ALL_SCOPES,
    agentRunId: internal.runId,
    defaultDashboardId: internal.dashboardId,
    requestId: internal.requestId,
  };
}

/**
 * Streamable-HTTP MCP server (stateless mode). Every POST creates a fresh
 * McpServer bound to the REQUEST's identity, so authorization and tenant
 * checks inside each tool match the caller exactly.
 */
export function createMcpRouter(deps: McpRouterDeps): Router {
  // Fail fast at mount time: a missing or weak internal secret must stop the
  // process, not silently weaken identity verification. resolveIdentity reads
  // the same validated value from deps on every request.
  assertInternalMcpSecret(deps.secret);
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

    const register = (
      name: string,
      description: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: { shape: any },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (input: any) => Promise<unknown>,
    ): void => {
      const requiredScope = TOOL_SCOPES[name];
      server.registerTool(
        name,
        { description, inputSchema: schema.shape },
        async (args: unknown) => {
          // Scope gate: external tokens without the scope never reach the tool.
          if (!hasScope(identity.scopes, requiredScope)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Missing scope: ${requiredScope ?? "unknown"} (token scopes: ${identity.scopes.join(", ") || "none"})`,
                  }),
                },
              ],
              isError: true,
            };
          }
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
      // Connected-client tracking (external tokens): the initialize request
      // carries the MCP clientInfo.
      if (identity.tokenId && req.body?.method === "initialize") {
        const info = req.body?.params?.clientInfo as
          | { name?: string; version?: string }
          | undefined;
        if (info?.name) {
          await trackMcpClient(deps.db, {
            tokenId: identity.tokenId,
            clientName: String(info.name).slice(0, 120),
            clientVersion: info.version ? String(info.version).slice(0, 60) : undefined,
          });
        }
      }
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
      const retryAfter = (e as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retryAfter !== undefined) {
        res.setHeader("Retry-After", String(retryAfter));
      }
      if (isAppError(e)) {
        const httpStatus: Record<string, number> = {
          BAD_REQUEST: 400,
          UNAUTHORIZED: 401,
          FORBIDDEN: 403,
          NOT_FOUND: 404,
          CONFLICT: 409,
          PAYLOAD_TOO_LARGE: 413,
          UNPROCESSABLE: 422,
          RATE_LIMITED: 429,
          QUOTA_EXCEEDED: 429,
          INTERNAL: 500,
        };
        res.status(httpStatus[e.code] ?? 500).json({
          error: { code: e.code, message: e.message, requestId: "", details: e.details ?? {} },
        });
        return;
      }
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
