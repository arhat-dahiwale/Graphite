import { desc, eq } from "drizzle-orm";
import { auditLogs } from "../schema/index";

type ActorType = "user" | "agent" | "mcp" | "system";
import type { DbLike } from "../client";

export interface AuditInput {
  organizationId: string;
  actorUserId?: string | null;
  actorType?: ActorType;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

/** Append an audit entry. Metadata must not contain secrets or raw data. */
export async function writeAudit(db: DbLike, input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? "user",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata ?? null,
  });
}

export async function listAudit(db: DbLike, organizationId: string, limit = 100) {
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
