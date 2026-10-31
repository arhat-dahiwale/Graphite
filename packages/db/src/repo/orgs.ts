import { eq } from "drizzle-orm";
import type { DbLike } from "../client.js";
import { members, organizations, type MemberRole, type Organization } from "../schema/index.js";

/** Get the organization row by id. Never filtered by caller; use membership checks. */
export async function getOrgById(db: DbLike, orgId: string): Promise<Organization | null> {
  const rows = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0] ?? null;
}

export async function getOrgBySlug(db: DbLike, slug: string): Promise<Organization | null> {
  const rows = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export interface CreateOrgInput {
  name: string;
  slug: string;
  createdBy: string;
  creatorRole?: MemberRole;
}

/** Create an org and make the creator a member (owner) in one transaction. */
export async function createOrg(db: DbLike, input: CreateOrgInput): Promise<Organization> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(organizations)
      .values({
        name: input.name,
        slug: input.slug,
        createdBy: input.createdBy,
      })
      .returning();
    const org = inserted[0];
    if (!org) throw new Error("Failed to create organization");
    await tx.insert(members).values({
      organizationId: org.id,
      userId: input.createdBy,
      role: input.creatorRole ?? "owner",
    });
    return org;
  });
}

export async function listOrgsForUser(db: DbLike, userId: string): Promise<Organization[]> {
  const rows = await db
    .select({ org: organizations })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(eq(members.userId, userId));
  return rows.map((r) => r.org);
}

export async function updateOrg(
  db: DbLike,
  orgId: string,
  patch: { name?: string; slug?: string },
): Promise<Organization | null> {
  const rows = await db
    .update(organizations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteOrg(db: DbLike, orgId: string): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, orgId));
}

export async function orgSlugExists(db: DbLike, slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return rows.length > 0;
}
