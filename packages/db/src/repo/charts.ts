import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { DbLike } from "../client";
import {
  chartVersions,
  charts,
  dashboardCharts,
  type Chart,
  type ChartVersion,
} from "../schema/index";

export interface CreateChartInput {
  organizationId: string;
  datasetId: string;
  title: string;
  spec: unknown; // validated ChartSpec (packages/chart-spec) before this call
  source: "manual" | "agent" | "mcp" | "revert";
  createdBy: string;
  agentRunId?: string | null;
  prompt?: string | null;
  dashboardId?: string | null;
  position?: { x: number; y: number; w: number; h: number; z?: number };
}

export interface CreatedChart {
  chart: Chart;
  version: ChartVersion;
}

/** Create a chart with its first version, optionally placed on a dashboard. */
export async function createChart(db: DbLike, input: CreateChartInput): Promise<CreatedChart> {
  return db.transaction(async (tx) => {
    const chartRows = await tx
      .insert(charts)
      .values({
        organizationId: input.organizationId,
        datasetId: input.datasetId,
        title: input.title,
        createdBy: input.createdBy,
      })
      .returning();
    const chart = chartRows[0];
    if (!chart) throw new Error("Failed to create chart");

    const versionRows = await tx
      .insert(chartVersions)
      .values({
        chartId: chart.id,
        versionNumber: 1,
        spec: input.spec as object,
        source: input.source,
        agentRunId: input.agentRunId ?? null,
        prompt: input.prompt ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    const version = versionRows[0];
    if (!version) throw new Error("Failed to create chart version");

    await tx
      .update(charts)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(charts.id, chart.id));

    if (input.dashboardId) {
      await tx.insert(dashboardCharts).values({
        dashboardId: input.dashboardId,
        chartId: chart.id,
        x: input.position?.x ?? 0,
        y: input.position?.y ?? 0,
        w: input.position?.w ?? 6,
        h: input.position?.h ?? 4,
        z: input.position?.z ?? 0,
      });
    }

    return { chart: { ...chart, currentVersionId: version.id }, version };
  });
}

export async function getChartInOrg(
  db: DbLike,
  organizationId: string,
  chartId: string,
): Promise<Chart | null> {
  const rows = await db
    .select()
    .from(charts)
    .where(and(eq(charts.id, chartId), eq(charts.organizationId, organizationId), isNull(charts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getChartById(db: DbLike, chartId: string): Promise<Chart | null> {
  const rows = await db.select().from(charts).where(eq(charts.id, chartId)).limit(1);
  return rows[0] ?? null;
}

export async function getCurrentVersion(db: DbLike, chartId: string): Promise<ChartVersion | null> {
  const chart = await getChartById(db, chartId);
  if (!chart?.currentVersionId) return null;
  const rows = await db
    .select()
    .from(chartVersions)
    .where(eq(chartVersions.id, chart.currentVersionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listChartVersions(db: DbLike, chartId: string): Promise<ChartVersion[]> {
  return db
    .select()
    .from(chartVersions)
    .where(eq(chartVersions.chartId, chartId))
    .orderBy(desc(chartVersions.versionNumber));
}

export interface CreateVersionInput {
  chartId: string;
  spec: unknown;
  source: "manual" | "agent" | "mcp" | "revert";
  createdBy: string;
  title?: string;
  agentRunId?: string | null;
  prompt?: string | null;
}

/** Append-only: create the next immutable version and point the chart at it. */
export async function createChartVersion(db: DbLike, input: CreateVersionInput): Promise<ChartVersion> {
  return db.transaction(async (tx) => {
    const chartRows = await tx
      .select()
      .from(charts)
      .where(eq(charts.id, input.chartId))
      .for("update")
      .limit(1);
    const chart = chartRows[0];
    if (!chart || chart.deletedAt) throw new Error("Chart not found");
    const maxRows = await tx
      .select({ v: chartVersions.versionNumber })
      .from(chartVersions)
      .where(eq(chartVersions.chartId, input.chartId))
      .orderBy(desc(chartVersions.versionNumber))
      .limit(1);
    const next = (maxRows[0]?.v ?? 0) + 1;
    const versionRows = await tx
      .insert(chartVersions)
      .values({
        chartId: input.chartId,
        versionNumber: next,
        spec: input.spec as object,
        source: input.source,
        agentRunId: input.agentRunId ?? null,
        prompt: input.prompt ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    const version = versionRows[0];
    if (!version) throw new Error("Failed to create version");
    await tx
      .update(charts)
      .set({
        currentVersionId: version.id,
        title: input.title ?? chart.title,
        updatedAt: new Date(),
      })
      .where(eq(charts.id, input.chartId));
    return version;
  });
}

/** Revert = a new version copied from an older one (history stays immutable). */
export async function revertChartVersion(
  db: DbLike,
  chartId: string,
  versionId: string,
  createdBy: string,
): Promise<ChartVersion> {
  const rows = await db
    .select()
    .from(chartVersions)
    .where(and(eq(chartVersions.id, versionId), eq(chartVersions.chartId, chartId)))
    .limit(1);
  const source = rows[0];
  if (!source) throw new Error("Version not found");
  return createChartVersion(db, {
    chartId,
    spec: source.spec,
    source: "revert",
    createdBy,
  });
}

export interface DashboardChartView {
  chart: Chart;
  version: ChartVersion | null;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export async function listDashboardCharts(db: DbLike, dashboardId: string): Promise<DashboardChartView[]> {
  const rows = await db
    .select({ placement: dashboardCharts, chart: charts })
    .from(dashboardCharts)
    .innerJoin(charts, eq(dashboardCharts.chartId, charts.id))
    .where(eq(dashboardCharts.dashboardId, dashboardId))
    .orderBy(asc(dashboardCharts.z));
  const views: DashboardChartView[] = [];
  for (const r of rows) {
    const versionRows = r.chart.currentVersionId
      ? await db.select().from(chartVersions).where(eq(chartVersions.id, r.chart.currentVersionId)).limit(1)
      : [];
    views.push({
      chart: r.chart,
      version: versionRows[0] ?? null,
      x: r.placement.x,
      y: r.placement.y,
      w: r.placement.w,
      h: r.placement.h,
      z: r.placement.z,
    });
  }
  return views;
}

export async function addToDashboard(
  db: DbLike,
  dashboardId: string,
  chartId: string,
  position?: { x: number; y: number; w: number; h: number; z?: number },
): Promise<void> {
  await db
    .insert(dashboardCharts)
    .values({
      dashboardId,
      chartId,
      x: position?.x ?? 0,
      y: position?.y ?? 0,
      w: position?.w ?? 6,
      h: position?.h ?? 4,
      z: position?.z ?? 0,
    })
    .onConflictDoNothing();
}

export async function removeFromDashboard(db: DbLike, dashboardId: string, chartId: string): Promise<void> {
  await db
    .delete(dashboardCharts)
    .where(
      and(eq(dashboardCharts.dashboardId, dashboardId), eq(dashboardCharts.chartId, chartId)),
    );
}
