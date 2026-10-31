import { initTRPC, TRPCError } from "@trpc/server";
import { AppError, type Actor } from "@graphite/core";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const TRPC_CODE_BY_APP_ERROR: Record<AppError["code"], TRPCError["code"]> = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNPROCESSABLE: "UNPROCESSABLE_CONTENT",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  QUOTA_EXCEEDED: "TOO_MANY_REQUESTS",
  INTERNAL: "INTERNAL_SERVER_ERROR",
};

export function toTrpcError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  if (e instanceof AppError) {
    return new TRPCError({
      code: TRPC_CODE_BY_APP_ERROR[e.code] ?? "INTERNAL_SERVER_ERROR",
      message: e.message,
      cause: e,
    });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unexpected error", cause: e });
}

/**
 * Resolve the caller's membership in `orgId` and check `action` authorization.
 * No membership -> NOT_FOUND (never leak cross-tenant existence);
 * insufficient role -> FORBIDDEN.
 */
export async function requireActor(
  ctx: Context,
  orgId: string,
): Promise<Actor> {
  const actor = await ctx.actorFor(orgId);
  if (!actor) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Resource not found" });
  }
  return actor;
}

/** Wraps a procedure handler so AppErrors map to clean tRPC errors. */
export function withAppErrors<TFn extends (opts: never) => Promise<unknown>>(fn: TFn): TFn {
  return (async (opts: never) => {
    try {
      return await fn(opts);
    } catch (e) {
      throw toTrpcError(e);
    }
  }) as TFn;
}
