import { z } from "zod";
import { getUsageSummary } from "@graphite/db/repo/usage";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

/** Org usage rollups (Phase 8). Owner only; tenant-scoped. */
export const usageRouter = router({
  orgSummary: authedProcedure
    .input(z.object({ orgId: z.string().min(1), days: z.number().int().min(1).max(90).optional() }))
    .query(async ({ ctx, input }) => {
      try {
        // API.md: usage.orgSummary is owner-only.
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        const rows = await getUsageSummary(ctx.db, input.orgId, input.days ?? 14);
        // Cost figures are simulated for mock runs — surfaced so the UI can
        // label them honestly.
        return {
          days: rows,
          costNote: process.env.LLM_PROVIDER === "anthropic" ? "provider-reported" : "simulated (mock model)",
        };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
