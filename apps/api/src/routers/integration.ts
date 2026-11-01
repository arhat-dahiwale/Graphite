import { z } from "zod";
import {
  createMcpToken,
  listMcpClients,
  listMcpTokens,
  revokeMcpToken,
} from "@graphite/mcp-server/tokens";
import { MCP_SCOPES } from "@graphite/mcp-server/scopes";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

/**
 * Personal access tokens for external MCP clients (Phase 7).
 * Tokens are created/listed/revoked by their owner; the plaintext is shown
 * exactly once at creation. Scopes and org binding are enforced in the MCP
 * server path.
 */
export const integrationRouter = router({
  listTokens: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "token:read", { type: "token" });
        // Callers only ever see their own tokens.
        return await listMcpTokens(ctx.db, { userId: ctx.user.id, organizationId: input.orgId });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  createToken: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1).max(100),
        scopes: z.array(z.enum(MCP_SCOPES)).min(1),
        expiresInDays: z.number().int().min(1).max(3650).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "token:write", {
          type: "token",
          ownerId: ctx.user.id,
        });
        const created = await createMcpToken(ctx.db, {
          userId: ctx.user.id,
          organizationId: input.orgId,
          name: input.name,
          scopes: input.scopes,
          expiresInDays: input.expiresInDays ?? null,
        });
        // Plaintext is returned exactly once, here.
        return created;
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  revokeToken: authedProcedure
    .input(z.object({ orgId: z.string().min(1), tokenId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "token:write", {
          type: "token",
          ownerId: ctx.user.id,
        });
        await revokeMcpToken(ctx.db, {
          tokenId: input.tokenId,
          userId: ctx.user.id,
          organizationId: input.orgId,
        });
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  listClients: authedProcedure
    .input(z.object({ orgId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "token:read", { type: "token" });
        return await listMcpClients(ctx.db, {
          userId: ctx.user.id,
          organizationId: input.orgId,
        });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
