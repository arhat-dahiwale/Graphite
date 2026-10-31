import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { DbLike } from "../client.js";
import { invitations, members, type Invitation, type MemberRole } from "../schema/index.js";

const INVITE_TTL_DAYS = 7;

/** Raw tokens are shown once; only the SHA-256 hash is stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): string {
  return `gin_${randomBytes(24).toString("base64url")}`;
}

export interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: MemberRole;
  invitedBy: string;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /** Raw token, shown once (returned to the inviter / sent by email). */
  token: string;
}

export async function createInvitation(
  db: DbLike,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const token = generateInviteToken();
  const rows = await db
    .insert(invitations)
    .values({
      organizationId: input.organizationId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: input.invitedBy,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning();
  const invitation = rows[0];
  if (!invitation) throw new Error("Failed to create invitation");
  return { invitation, token };
}

export async function listInvitations(
  db: DbLike,
  organizationId: string,
): Promise<Invitation[]> {
  return db
    .select()
    .from(invitations)
    .where(eq(invitations.organizationId, organizationId));
}

export async function findPendingByToken(
  db: DbLike,
  token: string,
): Promise<Invitation | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type AcceptResult =
  | { ok: true; organizationId: string; role: MemberRole }
  | { ok: false; reason: "not_found" | "expired" | "email_mismatch" };

/**
 * Accept a pending invitation: the caller must be signed in with the invited
 * email address. Adds membership and marks the invitation accepted atomically.
 */
export async function acceptInvitation(
  db: DbLike,
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, hashToken(token)), eq(invitations.status, "pending")))
      .for("update")
      .limit(1);
    const invitation = rows[0];
    if (!invitation) return { ok: false, reason: "not_found" } as const;
    if (invitation.expiresAt.getTime() < Date.now()) {
      await tx
        .update(invitations)
        .set({ status: "expired" })
        .where(eq(invitations.id, invitation.id));
      return { ok: false, reason: "expired" } as const;
    }
    if (invitation.email !== userEmail.toLowerCase()) {
      return { ok: false, reason: "email_mismatch" } as const;
    }
    await tx.insert(members).values({
      organizationId: invitation.organizationId,
      userId,
      role: invitation.role,
    });
    await tx
      .update(invitations)
      .set({ status: "accepted" })
      .where(eq(invitations.id, invitation.id));
    return { ok: true, organizationId: invitation.organizationId, role: invitation.role } as const;
  });
}

export async function revokeInvitation(db: DbLike, organizationId: string, invitationId: string): Promise<void> {
  await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.organizationId, organizationId), eq(invitations.id, invitationId)));
}
