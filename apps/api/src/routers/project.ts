import { z } from "zod";
import { notFound } from "@graphite/core";
import {
  createProject,
  getProjectInOrg,
  listProjectsInOrg,
  softDeleteProject,
  updateProject,
} from "@graphite/db/repo/projects";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

export const projectRouter = router({
  list: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "project:read", { type: "project" });
        return await listProjectsInOrg(ctx.db, input.orgId);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ orgId: z.string().min(1), projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "project:read", { type: "project" });
        const project = await getProjectInOrg(ctx.db, input.orgId, input.projectId);
        if (!project) throw notFound();
        return project;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  create: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1).max(100),
        description: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "project:write", { type: "project" });
        return await createProject(ctx.db, {
          organizationId: input.orgId,
          name: input.name,
          description: input.description ?? null,
          createdBy: ctx.user.id,
        });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  update: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        projectId: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "project:write", { type: "project" });
        const { orgId, projectId, ...patch } = input;
        const project = await updateProject(ctx.db, orgId, projectId, patch);
        if (!project) throw notFound();
        return project;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  delete: authedProcedure
    .input(z.object({ orgId: z.string().min(1), projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "project:write", { type: "project" });
        const ok = await softDeleteProject(ctx.db, input.orgId, input.projectId);
        if (!ok) throw notFound();
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
