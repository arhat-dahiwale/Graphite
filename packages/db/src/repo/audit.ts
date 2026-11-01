import { count, desc, eq } from "drizzle-orm";
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

export interface AuditPage {
  rows: Array<{
    id: string;
    actorType: string;
    actorUserId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

/** Paginated, tenant-scoped audit listing for the owner-only viewer (Phase 10). */
export async function listAuditPage(
  db: DbLike,
  organizationId: string,
  opts: { page: number; pageSize: number },
): Promise<AuditPage> {
  const pageSize = Math.max(1, Math.min(Math.floor(opts.pageSize) || 25, 100));
  const page = Math.max(0, Math.floor(opts.page) || 0);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset(page * pageSize);
  const totals = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorType: r.actorType,
      actorUserId: r.actorUserId,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      createdAt: r.createdAt,
    })),
    total: Number(totals[0]?.n ?? 0),
    page,
    pageSize,
  };
}
