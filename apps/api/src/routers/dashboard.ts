import { z } from "zod";
import { notFound } from "@graphite/core";
import {
  createDashboard,
  getDashboardById,
  getLayout,
  listDashboardsInProject,
  renameDashboard,
  saveLayout,
  setFilters,
  setShare,
  softDeleteDashboard,
} from "@graphite/db/repo/dashboards";
import { getProjectById } from "@graphite/db/repo/projects";
import { listDashboardCharts } from "@graphite/db/repo/charts";
import type { Context } from "../context";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

const layoutItemSchema = z.object({
  chartId: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
  z: z.number().int().min(0),
});

/** Same validated shape as chart-spec query filters (field/op/value). */
export const dashboardFilterSchema = z
  .object({
    field: z.string().min(1).max(100),
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "like"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
  })
  .strict();

/** Resolve a dashboard by id; NOT_FOUND unless the caller is a member. */
async function resolveDashboard(ctx: Context, dashboardId: string) {
  const dash = await getDashboardById(ctx.db, dashboardId);
  if (!dash || dash.deletedAt) throw notFound();
  await requireAuthorized(ctx, dash.organizationId, "dashboard:read", { type: "dashboard" });
  return dash;
}

export const dashboardRouter = router({
  list: authedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const project = await getProjectById(ctx.db, input.projectId);
        if (!project || project.deletedAt) throw notFound();
        await requireAuthorized(ctx, project.organizationId, "project:read", { type: "project" });
        return listDashboardsInProject(ctx.db, input.projectId);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  create: authedProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        name: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const project = await getProjectById(ctx.db, input.projectId);
        if (!project || project.deletedAt) throw notFound();
        await requireAuthorized(ctx, project.organizationId, "dashboard:write", { type: "dashboard" });
        return await createDashboard(ctx.db, {
          organizationId: project.organizationId,
          projectId: input.projectId,
          name: input.name,
          createdBy: ctx.user.id,
        });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        const [charts, layout] = await Promise.all([
          listDashboardCharts(ctx.db, dash.id),
          getLayout(ctx.db, dash.id),
        ]);
        return { dashboard: dash, charts, layout };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  rename: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1), name: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        await requireAuthorized(ctx, dash.organizationId, "dashboard:write", { type: "dashboard" });
        const updated = await renameDashboard(ctx.db, dash.organizationId, dash.id, input.name);
        if (!updated) throw notFound();
        return updated;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  delete: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        await requireAuthorized(ctx, dash.organizationId, "dashboard:write", { type: "dashboard" });
        await softDeleteDashboard(ctx.db, dash.organizationId, dash.id);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  saveLayout: authedProcedure
    .input(
      z.object({
        dashboardId: z.string().min(1),
        baseVersion: z.number().int().min(1),
        items: z.array(layoutItemSchema).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        await requireAuthorized(ctx, dash.organizationId, "dashboard:write", { type: "dashboard" });
        return await saveLayout(ctx.db, dash.id, input.baseVersion, input.items);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  // Public share link (Phase 10): enable generates a share id, disable revokes
  // access. The public payload is served by GET /api/v1/public/dashboards/:shareId.
  setShare: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        await requireAuthorized(ctx, dash.organizationId, "dashboard:write", { type: "dashboard" });
        const result = await setShare(ctx.db, dash.organizationId, dash.id, input.enabled);
        if (!result) throw notFound();
        return result;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  // Dashboard-level filters (Phase 10): validated {field,op,value} structure
  // applied through the chart query compiler — never string-built SQL.
  setFilters: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1), filters: z.array(dashboardFilterSchema).max(10) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const dash = await resolveDashboard(ctx, input.dashboardId);
        await requireAuthorized(ctx, dash.organizationId, "dashboard:write", { type: "dashboard" });
        const updated = await setFilters(ctx.db, dash.organizationId, dash.id, input.filters);
        if (!updated) throw notFound();
        return { ok: true, filters: input.filters };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
