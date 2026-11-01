import { z } from "zod";
import { notFound, unprocessable } from "@graphite/core";
import { safeParseChartSpec, compileChartQuery } from "@graphite/chart-spec";
import { datasetColumns } from "@graphite/db/schema";
import { getDatasetById } from "@graphite/db/repo/datasets";
import {
  addToDashboard,
  createChart,
  createChartVersion,
  getChartById,
  getCurrentVersion,
  listChartVersions,
  removeFromDashboard,
  revertChartVersion,
} from "@graphite/db/repo/charts";
import { getDashboardById } from "@graphite/db/repo/dashboards";
import { writeAudit } from "@graphite/db/repo/audit";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "../context";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

const specInput = z.unknown();

/** Resolve a chart by id; NOT_FOUND unless the caller is a member of its org. */
async function resolveChart(ctx: Context, chartId: string) {
  const chart = await getChartById(ctx.db, chartId);
  if (!chart || chart.deletedAt) throw notFound();
  await requireAuthorized(ctx, chart.organizationId, "chart:read", { type: "chart" });
  return chart;
}

/** Load the dataset metadata needed to compile a chart's query. */
async function loadCompileDataset(ctx: Context, datasetId: string) {
  const ds = await getDatasetById(ctx.db, datasetId);
  if (!ds || ds.deletedAt || ds.status !== "ready" || !ds.tableName) {
    throw unprocessable("Dataset is not ready");
  }
  const cols = await ctx.db
    .select()
    .from(datasetColumns)
    .where(and(eq(datasetColumns.datasetId, datasetId)))
    .orderBy(asc(datasetColumns.position));
  return {
    tableName: ds.tableName,
    columns: cols.map((c) => ({
      name: c.name,
      type: (c.userType ?? c.inferredType) as "number" | "integer" | "text" | "boolean" | "date" | "datetime",
    })),
    datasetId: ds.id,
    organizationId: ds.organizationId,
  };
}

export const chartRouter = router({
  create: authedProcedure
    .input(
      z.object({
        datasetId: z.string().min(1),
        spec: specInput,
        dashboardId: z.string().min(1).optional(),
        position: z
          .object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(24) })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const parsed = safeParseChartSpec(input.spec);
        if (!parsed.ok) throw unprocessable(`Invalid chart spec: ${parsed.error}`);
        const spec = parsed.spec;
        if (spec.datasetId !== input.datasetId) {
          throw unprocessable("Spec datasetId does not match the target dataset");
        }
        const compileDs = await loadCompileDataset(ctx, input.datasetId);
        await requireAuthorized(ctx, compileDs.organizationId, "chart:write", { type: "chart" });
        try {
          compileChartQuery(spec, compileDs); // fail fast on uncompilable queries
        } catch (e) {
          throw unprocessable(e instanceof Error ? e.message : "Invalid chart query");
        }

        const { chart, version } = await createChart(ctx.db, {
          organizationId: compileDs.organizationId,
          datasetId: input.datasetId,
          title: spec.title,
          spec,
          source: "manual",
          createdBy: ctx.user.id,
          dashboardId: input.dashboardId ?? null,
          position: input.position,
        });
        await writeAudit(ctx.db, {
          organizationId: compileDs.organizationId,
          actorUserId: ctx.user.id,
          action: "chart.create",
          resourceType: "chart",
          resourceId: chart.id,
          metadata: { source: "manual", chartType: spec.type },
        });
        return { chart, version };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ chartId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const chart = await resolveChart(ctx, input.chartId);
        const version = await getCurrentVersion(ctx.db, chart.id);
        return { chart, version };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  versions: authedProcedure
    .input(z.object({ chartId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await resolveChart(ctx, input.chartId);
        return listChartVersions(ctx.db, input.chartId);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  createVersion: authedProcedure
    .input(z.object({ chartId: z.string().min(1), spec: specInput }))
    .mutation(async ({ ctx, input }) => {
      try {
        const chart = await resolveChart(ctx, input.chartId);
        await requireAuthorized(ctx, chart.organizationId, "chart:write", { type: "chart" });
        const parsed = safeParseChartSpec(input.spec);
        if (!parsed.ok) throw unprocessable(`Invalid chart spec: ${parsed.error}`);
        const compileDs = await loadCompileDataset(ctx, parsed.spec.datasetId);
        if (compileDs.datasetId !== chart.datasetId) {
          throw unprocessable("Spec targets a different dataset than the chart");
        }
        try {
          compileChartQuery(parsed.spec, compileDs);
        } catch (e) {
          throw unprocessable(e instanceof Error ? e.message : "Invalid chart query");
        }
        const version = await createChartVersion(ctx.db, {
          chartId: chart.id,
          spec: parsed.spec,
          source: "manual",
          createdBy: ctx.user.id,
          title: parsed.spec.title,
        });
        await writeAudit(ctx.db, {
          organizationId: chart.organizationId,
          actorUserId: ctx.user.id,
          action: "chart.version.create",
          resourceType: "chart",
          resourceId: chart.id,
          metadata: { version: version.versionNumber, source: "manual" },
        });
        return version;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  revert: authedProcedure
    .input(z.object({ chartId: z.string().min(1), versionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const chart = await resolveChart(ctx, input.chartId);
        await requireAuthorized(ctx, chart.organizationId, "chart:write", { type: "chart" });
        const version = await revertChartVersion(ctx.db, chart.id, input.versionId, ctx.user.id);
        await writeAudit(ctx.db, {
          organizationId: chart.organizationId,
          actorUserId: ctx.user.id,
          action: "chart.revert",
          resourceType: "chart",
          resourceId: chart.id,
          metadata: { revertedToVersionId: input.versionId, newVersion: version.versionNumber },
        });
        return version;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  addToDashboard: authedProcedure
    .input(
      z.object({
        dashboardId: z.string().min(1),
        chartId: z.string().min(1),
        position: z
          .object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(24) })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await getDashboardById(ctx.db, input.dashboardId);
        if (!dash || dash.deletedAt) throw notFound();
        await requireAuthorized(ctx, dash.organizationId, "chart:write", { type: "chart" });
        await resolveChart(ctx, input.chartId);
        await addToDashboard(ctx.db, input.dashboardId, input.chartId, input.position);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  removeFromDashboard: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1), chartId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await getDashboardById(ctx.db, input.dashboardId);
        if (!dash || dash.deletedAt) throw notFound();
        await requireAuthorized(ctx, dash.organizationId, "chart:write", { type: "chart" });
        await removeFromDashboard(ctx.db, input.dashboardId, input.chartId);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  /** Query results for rendering the current spec (through the data service). */
  data: authedProcedure
    .input(z.object({ chartId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const chart = await resolveChart(ctx, input.chartId);
        const version = await getCurrentVersion(ctx.db, chart.id);
        if (!version) throw notFound("Chart has no version");
        const parsed = safeParseChartSpec(version.spec);
        if (!parsed.ok) throw unprocessable("Stored spec is invalid");
        const compileDs = await loadCompileDataset(ctx, chart.datasetId);
        const compiled = compileChartQuery(parsed.spec, compileDs);
        const result = await ctx.getDataClient().runQuery(
          { organizationId: chart.organizationId, userId: ctx.user.id, requestId: ctx.requestId },
          [chart.datasetId],
          compiled.sql,
          parsed.spec.query.limit ?? 1000,
          10_000,
        );
        const rows = result.rows.map((row) =>
          Object.fromEntries(
            result.columns.map((c, i) => {
              let v: unknown = null;
              try {
                v = row.valuesJson[i] === undefined ? null : JSON.parse(row.valuesJson[i] as string);
              } catch {
                v = row.valuesJson[i] ?? null;
              }
              // Postgres numerics (SUM over bigint) arrive as strings.
              if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
              return [c, v];
            }),
          ),
        );
        return { columns: result.columns, rows, truncated: result.truncated };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
