import type { Actor, Role } from "@graphite/core";
import { authorize } from "@graphite/core";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import type Redis from "ioredis";
import type { DataClient } from "@graphite/data/client";
import { forbidden, notFound } from "@graphite/core";
import { getMembership } from "@graphite/db/repo/members";

/**
 * Every tool call executes with the caller's identity. Internal agent runs
 * and external MCP clients build the same context, so role and tenant checks
 * are identical for both.
 */
export interface ToolContext {
  db: Database;
  sql: Sql;
  redis: Redis;
  getDataClient: () => DataClient;
  actor: Actor;
  /** Set when the caller is an agent run (stamped onto chart versions). */
  agentRunId?: string;
  /** Agent runs are dashboard-scoped: charts default to this dashboard. */
  defaultDashboardId?: string;
  requestId: string;
}

/**
 * Resolve an actor for a user within an org (shared by internal and MCP paths).
 * Throws NOT_FOUND when the user is not a member (never leak existence).
 */
export async function actorForUser(
  db: Database,
  userId: string,
  orgId: string,
): Promise<Actor> {
  const role = await getMembership(db, orgId, userId);
  if (!role) throw notFound();
  return { userId, orgId, role };
}

/** Enforce an action with the central authorize() matrix. */
export function requireTool(
  actor: Actor,
  action: Parameters<typeof authorize>[1],
  resource: Parameters<typeof authorize>[2],
): void {
  if (!authorize(actor, action, resource)) {
    throw forbidden(`Not allowed: ${action}`);
  }
}

export type ToolRole = Role;
