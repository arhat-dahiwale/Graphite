import { z } from "zod";
import { badRequest, conflict } from "@graphite/core";
import {
  createOrg,
  getOrgById,
  listOrgsForUser,
  orgSlugExists,
  softDeleteOrg,
  updateOrg,
} from "@graphite/db/repo/orgs";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base.length > 0 ? base : "org";
}

export const orgRouter = router({
  list: authedProcedure.query(async ({ ctx }) => {
    try {
      return await listOrgsForUser(ctx.db, ctx.user.id);
    } catch (e) {
      throw toTrpcError(e);
    }
  }),

  create: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z.string().max(63).regex(SLUG_RE, "Slug must be lowercase letters, digits, dashes").optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        let slug = input.slug ?? slugify(input.name);
        if (await orgSlugExists(ctx.db, slug)) {
          if (input.slug) throw conflict("Slug already taken");
          slug = `${slug}-${crypto.randomUUID().slice(0, 4).toLowerCase()}`;
          if (await orgSlugExists(ctx.db, slug)) throw conflict("Slug already taken");
        }
        return await createOrg(ctx.db, {
          name: input.name,
          slug,
          createdBy: ctx.user.id,
        });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:read", { type: "organization" });
        const org = await getOrgById(ctx.db, input.orgId);
        if (!org) throw badRequest("Organization missing");
        return org;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  update: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        slug: z.string().max(63).regex(SLUG_RE).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        if (input.slug && (await orgSlugExists(ctx.db, input.slug))) {
          throw conflict("Slug already taken");
        }
        const { orgId, ...patch } = input;
        return await updateOrg(ctx.db, orgId, patch);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  delete: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        await softDeleteOrg(ctx.db, input.orgId);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
