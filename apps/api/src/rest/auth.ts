import type { Request } from "express";
import { authorize, forbidden, notFound, type Action, type ResourceType, type Role } from "@graphite/core";
import type { Database } from "@graphite/db/client";
import { getMembership } from "@graphite/db/repo/members";
import type { GraphiteAuth } from "../auth";
import type { SessionUser } from "../context";

export interface RestSession {
  user: SessionUser;
}

/** Resolve the REST session user, mirroring the tRPC context behavior. */
export async function resolveRestUser(
  auth: GraphiteAuth | undefined,
  req: Request,
): Promise<SessionUser | null> {
  if (!auth) return null;
  return auth.resolveSession(req.headers);
}

/**
 * Tenant authorization for REST routes: membership is required (otherwise
 * NOT_FOUND so cross-tenant existence never leaks), then the role matrix.
 */
export async function requireRestAuthorized(
  db: Database,
  user: SessionUser,
  orgId: string,
  action: Action,
  resource: { type: ResourceType },
): Promise<{ userId: string; orgId: string; role: Role }> {
  const role = await getMembership(db, orgId, user.id);
  if (!role) throw notFound();
  const actor = { userId: user.id, orgId, role };
  const ok = authorize(actor, action, { ...resource, organizationId: orgId });
  if (!ok) throw forbidden();
  return actor;
}
