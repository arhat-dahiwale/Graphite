import { Router, type Request, type Response } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { isAppError, notFound, forbidden } from "@graphite/core";
import { safeParseChartSpec, compileChartQuery } from "@graphite/chart-spec";
import { dashboards } from "@graphite/db/schema";
import { getDashboardById, getLayout } from "@graphite/db/repo/dashboards";
import { getDatasetById } from "@graphite/db/repo/datasets";
import { getChartById, getCurrentVersion } from "@graphite/db/repo/charts";
import { datasetColumns } from "@graphite/db/schema";
import type { AppDeps } from "../context";
import { requireRestAuthorized } from "./auth";

/**
 * Phase 10 REST:
 * - GET /api/v1/public/dashboards/:shareId  (no auth; share links)
 *   Payload is MINIMAL by design: dashboard name, chart specs, and the
 *   pre-aggregated data those charts need. No organization, member, or user
 *   information, and no raw dataset rows beyond what charts query.
 * - GET /api/v1/dashboards/:dashboardId/export?format=json (viewer+)
 */
export function publicRestRouter(deps: AppDeps): Router {
  const r = Router();

  async function chartDataFor(dashboardId: string, spec: unknown): Promise<unknown> {
    const parsed = safeParseChartSpec(spec);
    if (!parsed.ok) return { error: "invalid spec" };
    const ds = await getDatasetById(deps.db, parsed.spec.datasetId);
    if (!ds || ds.deletedAt || ds.status !== "ready" || !ds.tableName) {
      return { error: "dataset not ready" };
    }
    const cols = await deps.db
      .select()
      .from(datasetColumns)
      .where(eq(datasetColumns.datasetId, ds.id))
      .orderBy(asc(datasetColumns.position));
    let compiled;
    try {
      compiled = compileChartQuery(parsed.spec, {
        tableName: ds.tableName,
        columns: cols.map((c) => ({
          name: c.name,
          type: (c.userType ?? c.inferredType) as
            | "number"
            | "integer"
            | "text"
            | "boolean"
            | "date"
            | "datetime",
        })),
      });
    } catch {
      return { error: "query failed to compile" };
    }
    const result = await deps.getDataClient().runQuery(
      { organizationId: ds.organizationId, userId: "public-share", requestId: `share_${Date.now()}` },
      [ds.id],
      compiled.sql,
      parsed.spec.query.limit ?? 1000,
      10_000,
    );
    return {
      columns: result.columns,
      rows: result.rows.map((row) =>
        result.columns.map((_, i) => {
          let v: unknown = null;
          try {
            v = JSON.parse(row.valuesJson[i] as string);
          } catch {
            v = row.valuesJson[i] ?? null;
          }
          // Postgres numerics (SUM over bigint) arrive as strings.
          if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
          return v;
        }),
      ),
    };
  }

  r.get("/public/dashboards/:shareId", async (req: Request, res: Response) => {
    try {
      const shareId = String(req.params.shareId ?? "");
      const rows = await deps.db
        .select()
        .from(dashboards)
        .where(
          and(
            eq(dashboards.shareId, shareId),
            eq(dashboards.shareEnabled, true),
            isNull(dashboards.deletedAt),
          ),
        )
        .limit(1);
      const dash = rows[0];
      if (!dash) throw notFound("Share link not found or revoked");

      const layout = await getLayout(deps.db, dash.id);
      const charts = [];
      for (const item of layout.items) {
        const chart = await getChartById(deps.db, item.chartId);
        if (!chart || chart.deletedAt) continue;
        const version = await getCurrentVersion(deps.db, chart.id);
        if (!version) continue;
        charts.push({
          chartId: chart.id,
          title: chart.title,
          position: { x: item.x, y: item.y, w: item.w, h: item.h, z: item.z },
          spec: version.spec,
          data: await chartDataFor(dash.id, version.spec),
        });
      }
      // Deliberately excludes organization, member, and user information.
      res.json({
        dashboard: { id: dash.id, name: dash.name, filters: dash.filters ?? [] },
        charts,
      });
    } catch (e) {
      if (isAppError(e)) {
        const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400;
        res.status(status).json({
          error: { code: e.code, message: e.message, requestId: "", details: {} },
        });
        return;
      }
      throw e;
    }
  });

  r.get("/dashboards/:dashboardId/export", async (req: Request, res: Response) => {
    try {
      const user = deps.auth ? await deps.auth.resolveSession(req.headers) : null;
      if (!user) throw forbidden("Sign in required");
      const dash = await getDashboardById(deps.db, String(req.params.dashboardId ?? ""));
      if (!dash || dash.deletedAt) throw notFound();
      await requireRestAuthorized(deps.db, user, dash.organizationId, "dashboard:read", {
        type: "dashboard",
      });
      const format = String(req.query.format ?? "json");
      if (format !== "json") {
        res.status(400).json({
          error: {
            code: "BAD_REQUEST",
            message: "Unsupported format; PNG export runs client-side from ECharts",
            requestId: "",
            details: {},
          },
        });
        return;
      }
      const layout = await getLayout(deps.db, dash.id);
      const charts = [];
      for (const item of layout.items) {
        const chart = await getChartById(deps.db, item.chartId);
        if (!chart || chart.deletedAt) continue;
        const version = await getCurrentVersion(deps.db, chart.id);
        if (!version) continue;
        charts.push({
          chartId: chart.id,
          title: chart.title,
          position: { x: item.x, y: item.y, w: item.w, h: item.h, z: item.z },
          spec: version.spec,
        });
      }
      res.setHeader(
        "content-disposition",
        `attachment; filename="dashboard-${dash.id}.json"`,
      );
      res.json({
        exportedAt: new Date().toISOString(),
        dashboard: { id: dash.id, name: dash.name, layoutVersion: layout.layoutVersion },
        layout: layout.items,
        charts,
      });
    } catch (e) {
      if (isAppError(e)) {
        const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 400;
        res.status(status).json({
          error: { code: e.code, message: e.message, requestId: "", details: {} },
        });
        return;
      }
      throw e;
    }
  });

  return r;
}
