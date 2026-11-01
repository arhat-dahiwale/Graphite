import { authorize, forbidden, notFound, type Action, type Actor, type AuthorizeResource, type ResourceType } from "@graphite/core";
import type { Context } from "./context.js";

type ResourceInput = Partial<Pick<AuthorizeResource, "ownerId">> & {
  type: ResourceType;
};

/**
 * Resolve the caller's membership in `organizationId` and enforce `action`.
 * - No membership: NOT_FOUND (never leak cross-tenant existence)
 * - Insufficient role: FORBIDDEN
 * Returns the resolved actor on success.
 */
export async function requireAuthorized(
  ctx: Context,
  organizationId: string,
  action: Action,
  resource: ResourceInput,
): Promise<Actor> {
  const actor = await ctx.actorFor(organizationId);
  if (!actor) throw notFound();
  const authorized = authorize(actor, action, {
    type: resource.type,
    organizationId,
    ownerId: resource.ownerId,
  });
  if (!authorized) throw forbidden();
  return actor;
}
