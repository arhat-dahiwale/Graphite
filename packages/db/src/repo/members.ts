import { and, asc, eq } from "drizzle-orm";
import type { DbLike } from "../client";
import { members, users, type MemberRole } from "../schema/index";

export interface MemberWithUser {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  createdAt: Date;
}

/** Role of a user within an org, or null when not a member. */
export async function getMembership(
  db: DbLike,
  organizationId: string,
  userId: string,
): Promise<MemberRole | null> {
  const rows = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function listMembers(db: DbLike, organizationId: string): Promise<MemberWithUser[]> {
  const rows = await db
    .select({
      membershipId: members.id,
      userId: members.userId,
      email: users.email,
      name: users.name,
      role: members.role,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, organizationId))
    .orderBy(asc(members.createdAt));
  return rows;
}

export async function addMember(
  db: DbLike,
  organizationId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db.insert(members).values({ organizationId, userId, role });
}

export async function updateMemberRole(
  db: DbLike,
  organizationId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db
    .update(members)
    .set({ role })
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)));
}

export async function removeMember(db: DbLike, organizationId: string, userId: string): Promise<void> {
  await db
    .delete(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)));
}

export async function countOwners(db: DbLike, organizationId: string): Promise<number> {
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.role, "owner")));
  return rows.length;
}
