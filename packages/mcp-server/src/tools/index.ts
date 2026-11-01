import { z } from "zod";
import { notFound, unprocessable, dashboardEventsChannel } from "@graphite/core";
import { datasetColumns } from "@graphite/db/schema";
import { asc, eq } from "drizzle-orm";
import { safeParseChartSpec, compileChartQuery } from "@graphite/chart-spec";
import {
  createChart,
  createChartVersion,
  getChartById,
  getDashboardPlacements,
} from "@graphite/db/repo/charts";
import { getDatasetById } from "@graphite/db/repo/datasets";
import { getDashboardById } from "@graphite/db/repo/dashboards";
import { writeAudit } from "@graphite/db/repo/audit";

import { requireTool, type ToolContext } from "../context";

export type { ToolContext };

/** Resolve a dataset for a tool caller; NOT_FOUND across tenants. */
async function toolDataset(ctx: ToolContext, datasetId: string) {
  const ds = await getDatasetById(ctx.db, datasetId);
  if (!ds || ds.deletedAt) throw notFound("Dataset not found");
  if (ds.organizationId !== ctx.actor.orgId) throw notFound("Dataset not found");
  return ds;
}

async function compileDatasetFor(ctx: ToolContext, datasetId: string) {
  const ds = await toolDataset(ctx, datasetId);
  if (ds.status !== "ready" || !ds.tableName) {
    throw unprocessable("Dataset is not ready for querying");
  }
  const cols = await ctx.db
    .select()
    .from(datasetColumns)
    .where(eq(datasetColumns.datasetId, ds.id))
    .orderBy(asc(datasetColumns.position));
  return {
    dataset: ds,
    compile: {
      tableName: ds.tableName,
      columns: cols.map((c) => ({
        name: c.name,
        type: (c.userType ?? c.inferredType) as "number" | "integer" | "text" | "boolean" | "date" | "datetime",
      })),
    },
  };
}

async function publishChartEvent(
  ctx: ToolContext,
  dashboardId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.redis.publish(
    dashboardEventsChannel(dashboardId),
    JSON.stringify({ type: "chart:version-created", dashboardId, data }),
  );
}

// ---------------------------------------------------------------------------
// describe_dataset
// ---------------------------------------------------------------------------

export const describeDatasetInput = z.object({ datasetId: z.string().min(1) });

export async function describeDataset(
  ctx: ToolContext,
  input: z.output<typeof describeDatasetInput>,
) {
  const { dataset } = await compileDatasetFor(ctx, input.datasetId);
  requireTool(ctx.actor, "dataset:read", {
    type: "dataset",
    organizationId: dataset.organizationId,
  });
  const cols = await ctx.db
    .select()
    .from(datasetColumns)
    .where(eq(datasetColumns.datasetId, dataset.id))
    .orderBy(asc(datasetColumns.position));
  return {
    datasetId: dataset.id,
    name: dataset.name,
    tableName: dataset.tableName,
    rowCount: dataset.rowCount ?? 0,
    columns: cols.map((c) => ({
      name: c.name,
      originalName: c.originalName,
      type: c.userType ?? c.inferredType,
      nullable: c.nullable,
      stats: c.stats ?? {},
    })),
  };
}

// ---------------------------------------------------------------------------
// run_sql
// ---------------------------------------------------------------------------

export const runSqlInput = z.object({
  datasetId: z.string().min(1),
  sql: z.string().min(1).max(100_000),
  limit: z.number().int().min(1).max(1000).default(100),
});

export async function runSql(ctx: ToolContext, input: z.output<typeof runSqlInput>) {
  const { dataset } = await compileDatasetFor(ctx, input.datasetId);
  requireTool(ctx.actor, "dataset:read", {
    type: "dataset",
    organizationId: dataset.organizationId,
  });
  const result = await ctx.getDataClient().runQuery(
    {
      organizationId: ctx.actor.orgId,
      userId: ctx.actor.userId,
      requestId: ctx.requestId,
    },
    [dataset.id],
    input.sql,
    input.limit,
    10_000,
  );
  return {
    columns: result.columns,
    rows: result.rows.map((row) =>
      Object.fromEntries(
        result.columns.map((c, i) => {
          let v: unknown = null;
          try {
            v = row.valuesJson[i] === undefined ? null : JSON.parse(row.valuesJson[i] as string);
          } catch {
            v = row.valuesJson[i] ?? null;
          }
          if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
          return [c, v];
        }),
      ),
    ),
    rowCount: result.rows.length,
    truncated: result.truncated,
    durationMs: result.durationMs,
  };
}

// ---------------------------------------------------------------------------
// create_chart_spec
// ---------------------------------------------------------------------------

export const createChartSpecInput = z.object({
  spec: z.unknown(),
  dashboardId: z.string().min(1).optional(),
});

export async function createChartSpec(
  ctx: ToolContext,
  input: z.output<typeof createChartSpecInput>,
) {
  const parsed = safeParseChartSpec(input.spec);
  if (!parsed.ok) throw unprocessable(`Invalid chart spec: ${parsed.error}`);
  const spec = parsed.spec;
  const { dataset, compile } = await compileDatasetFor(ctx, spec.datasetId);
  requireTool(ctx.actor, "chart:write", {
    type: "chart",
    organizationId: dataset.organizationId,
  });
  try {
    compileChartQuery(spec, compile);
  } catch (e) {
    throw unprocessable(e instanceof Error ? e.message : "Chart query failed to compile");
  }

  let dashboardId: string | null = ctx.defaultDashboardId ?? null;
  if (input.dashboardId) {
    const dash = await getDashboardById(ctx.db, input.dashboardId);
    if (!dash || dash.deletedAt || dash.organizationId !== ctx.actor.orgId) {
      throw notFound("Dashboard not found");
    }
    dashboardId = dash.id;
  }

  const { chart, version } = await createChart(ctx.db, {
    organizationId: dataset.organizationId,
    datasetId: dataset.id,
    title: spec.title,
    spec,
    source: ctx.agentRunId ? "agent" : "mcp",
    createdBy: ctx.actor.userId,
    agentRunId: ctx.agentRunId ?? null,
    dashboardId,
    position: dashboardId ? { x: 0, y: 0, w: 6, h: 4 } : undefined,
  });
  await writeAudit(ctx.db, {
    organizationId: dataset.organizationId,
    actorUserId: ctx.actor.userId,
    actorType: ctx.agentRunId ? "agent" : "mcp",
    action: "chart.create",
    resourceType: "chart",
    resourceId: chart.id,
    metadata: {
      source: ctx.agentRunId ? "agent" : "mcp",
      chartType: spec.type,
      runId: ctx.agentRunId,
    },
  });
  if (dashboardId) {
    await publishChartEvent(ctx, dashboardId, {
      chartId: chart.id,
      versionId: version.id,
      version: version.versionNumber,
      source: version.source,
    });
  }
  return { chartId: chart.id, versionId: version.id, version: version.versionNumber, dashboardId };
}

// ---------------------------------------------------------------------------
// update_chart_spec
// ---------------------------------------------------------------------------

export const updateChartSpecInput = z.object({
  chartId: z.string().min(1),
  spec: z.unknown(),
  reason: z.string().max(500).optional(),
});

export async function updateChartSpec(
  ctx: ToolContext,
  input: z.output<typeof updateChartSpecInput>,
) {
  const chart = await getChartById(ctx.db, input.chartId);
  if (!chart || chart.deletedAt) throw notFound("Chart not found");
  if (chart.organizationId !== ctx.actor.orgId) throw notFound("Chart not found");
  requireTool(ctx.actor, "chart:write", {
    type: "chart",
    organizationId: chart.organizationId,
  });

  const parsed = safeParseChartSpec(input.spec);
  if (!parsed.ok) throw unprocessable(`Invalid chart spec: ${parsed.error}`);
  if (parsed.spec.datasetId !== chart.datasetId) {
    throw unprocessable("Spec targets a different dataset than the chart");
  }
  const { compile } = await compileDatasetFor(ctx, chart.datasetId);
  try {
    compileChartQuery(parsed.spec, compile);
  } catch (e) {
    throw unprocessable(e instanceof Error ? e.message : "Chart query failed to compile");
  }

  const version = await createChartVersion(ctx.db, {
    chartId: chart.id,
    spec: parsed.spec,
    source: ctx.agentRunId ? "agent" : "mcp",
    createdBy: ctx.actor.userId,
    title: parsed.spec.title,
    agentRunId: ctx.agentRunId ?? null,
    prompt: input.reason ?? null,
  });
  await writeAudit(ctx.db, {
    organizationId: chart.organizationId,
    actorUserId: ctx.actor.userId,
    actorType: ctx.agentRunId ? "agent" : "mcp",
    action: "chart.version.create",
    resourceType: "chart",
    resourceId: chart.id,
    metadata: {
      version: version.versionNumber,
      source: version.source,
      runId: ctx.agentRunId,
      reason: input.reason,
    },
  });
  // Publish to every dashboard this chart sits on so open browsers update live.
  const placements = await getDashboardPlacements(ctx.db, chart.id);
  for (const p of placements) {
    await publishChartEvent(ctx, p, {
      chartId: chart.id,
      versionId: version.id,
      version: version.versionNumber,
      source: version.source,
    });
  }
  return { chartId: chart.id, versionId: version.id, version: version.versionNumber };
}
