import { z } from "zod";
import { badRequest, forbidden, notFound } from "@graphite/core";
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from "@graphite/db/repo/invitations";
import {
  countOwners,
  getMembership,
  listMembers,
  removeMember,
  updateMemberRole,
} from "@graphite/db/repo/members";
import { getOrgById } from "@graphite/db/repo/orgs";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";
import { sendInviteEmail } from "../mailer";

export const memberRouter = router({
  list: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:read", { type: "organization" });
        return await listMembers(ctx.db, input.orgId);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  listInvitations: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:read", { type: "organization" });
        const rows = await listInvitations(ctx.db, input.orgId);
        // Never expose token hashes.
        return rows.map(({ tokenHash: _tokenHash, ...rest }) => rest);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  invite: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        email: z.string().email().max(254),
        role: z.enum(["owner", "editor", "viewer"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        const org = await getOrgById(ctx.db, input.orgId);
        if (!org) throw notFound();
        const { invitation, token } = await createInvitation(ctx.db, {
          organizationId: input.orgId,
          email: input.email,
          role: input.role,
          invitedBy: ctx.user.id,
        });
        const inviteUrl = `${process.env.WEB_URL ?? "http://localhost:3000"}/invite/${token}`;
        await sendInviteEmail({
          to: input.email,
          organizationName: org.name,
          roleName: input.role,
          inviteUrl,
        });
        return { invitation, token, inviteUrl };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  revokeInvitation: authedProcedure
    .input(z.object({ orgId: z.string().min(1), invitationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        await revokeInvitation(ctx.db, input.orgId, input.invitationId);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  updateRole: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        userId: z.string().min(1),
        role: z.enum(["owner", "editor", "viewer"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        const current = await getMembership(ctx.db, input.orgId, input.userId);
        if (!current) throw notFound("Member not found");
        if (current === "owner" && input.role !== "owner") {
          const owners = await countOwners(ctx.db, input.orgId);
          if (owners <= 1) throw badRequest("Cannot demote the last owner");
        }
        await updateMemberRole(ctx.db, input.orgId, input.userId, input.role);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  remove: authedProcedure
    .input(z.object({ orgId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        const current = await getMembership(ctx.db, input.orgId, input.userId);
        if (!current) throw notFound("Member not found");
        if (current === "owner") {
          const owners = await countOwners(ctx.db, input.orgId);
          if (owners <= 1) throw badRequest("Cannot remove the last owner");
        }
        await removeMember(ctx.db, input.orgId, input.userId);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  leave: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const role = await ctx.actorFor(input.orgId);
        if (!role) throw notFound();
        if (role.role === "owner") {
          const owners = await countOwners(ctx.db, input.orgId);
          if (owners <= 1) {
            throw badRequest("Transfer ownership or invite another owner before leaving");
          }
        }
        await removeMember(ctx.db, input.orgId, ctx.user.id);
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  acceptInvite: authedProcedure
    .input(z.object({ token: z.string().min(10).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await acceptInvitation(
          ctx.db,
          input.token,
          ctx.user.id,
          ctx.user.email,
        );
        if (!result.ok) {
          if (result.reason === "not_found") throw notFound("Invitation not found");
          if (result.reason === "expired") {
            throw forbidden("Invitation expired");
          }
          throw forbidden("This invitation was sent to a different email address");
        }
        return { organizationId: result.organizationId, role: result.role };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
