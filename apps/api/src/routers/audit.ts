import { z } from "zod";
import { listAuditPage } from "@graphite/db/repo/audit";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

/** Audit log viewer (Phase 10): owner-only, tenant-scoped, paginated. */
export const auditRouter = router({
  list: authedProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        await requireAuthorized(ctx, input.orgId, "org:manage", { type: "organization" });
        return await listAuditPage(ctx.db, input.orgId, {
          page: input.page ?? 0,
          pageSize: input.pageSize ?? 25,
        });
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
