import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "@graphite/db/client";
import { mcpClients, mcpTokens } from "@graphite/db/schema";
import { forbidden, notFound, rateLimited } from "@graphite/core";
import { MCP_SCOPES, type McpScope } from "./scopes.js";

/**
 * Personal access tokens for external MCP clients (Phase 7).
 * - Format: gph_live_<43 base64url chars>; only the SHA-256 hash is stored.
 * - Shown once at creation; scoped; revocable; optional expiry.
 * - Bound to one organization and one user.
 */
export interface CreatedToken {
  id: string;
  /** Plaintext token — returned exactly once. */
  token: string;
  prefix: string;
  scopes: McpScope[];
  expiresAt: Date | null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `gph_live_${randomBytes(32).toString("base64url")}`;
}

const SCHEMA_SET = new Set<string>(MCP_SCOPES);

export function validateScopes(scopes: string[]): McpScope[] {
  if (scopes.length === 0) throw forbidden("A token needs at least one scope");
  for (const s of scopes) {
    if (!SCHEMA_SET.has(s)) throw forbidden(`Unknown scope: ${s}`);
  }
  return [...new Set(scopes)] as McpScope[];
}

export async function createMcpToken(
  db: Database,
  opts: {
    userId: string;
    organizationId: string;
    name: string;
    scopes: string[];
    expiresInDays?: number | null;
  },
): Promise<CreatedToken> {
  const scopes = validateScopes(opts.scopes);
  const token = generateToken();
  const expiresAt =
    opts.expiresInDays && opts.expiresInDays > 0
      ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
  const rows = await db
    .insert(mcpTokens)
    .values({
      userId: opts.userId,
      organizationId: opts.organizationId,
      name: opts.name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 13),
      scopes,
      expiresAt,
    })
    .returning();
  const t = rows[0]!;
  return {
    id: t.id,
    token,
    prefix: t.tokenPrefix,
    scopes: t.scopes as McpScope[],
    expiresAt: t.expiresAt,
  };
}

export interface ResolvedToken {
  id: string;
  userId: string;
  organizationId: string;
  scopes: McpScope[];
}

/** Resolve a plaintext bearer token to its row; null when invalid/expired/revoked. */
export async function resolveMcpToken(db: Database, token: string): Promise<ResolvedToken | null> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hashToken(token)), isNull(mcpTokens.revokedAt)))
    .limit(1);
  const t = rows[0];
  if (!t) return null;
  if (t.expiresAt !== null && t.expiresAt.getTime() < Date.now()) return null;
  return {
    id: t.id,
    userId: t.userId,
    organizationId: t.organizationId,
    scopes: t.scopes as McpScope[],
  };
}

export async function revokeMcpToken(
  db: Database,
  opts: { tokenId: string; userId: string; organizationId: string },
): Promise<void> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.id, opts.tokenId))
    .limit(1);
  const t = rows[0];
  if (!t || t.organizationId !== opts.organizationId) throw notFound("Token not found");
  if (t.userId !== opts.userId) throw forbidden("You can only revoke your own tokens");
  await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, opts.tokenId), isNull(mcpTokens.revokedAt)));
}

export interface TokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** List the caller's own tokens in an org (never the hash or plaintext). */
export async function listMcpTokens(
  db: Database,
  opts: { userId: string; organizationId: string },
): Promise<TokenView[]> {
  const rows = await db
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.userId, opts.userId), eq(mcpTokens.organizationId, opts.organizationId)))
    .orderBy(desc(mcpTokens.createdAt));
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    prefix: t.tokenPrefix,
    scopes: t.scopes,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  }));
}

export interface ClientView {
  id: string;
  tokenId: string;
  clientName: string;
  clientVersion: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** Connected MCP clients seen on the caller's tokens in an org. */
export async function listMcpClients(
  db: Database,
  opts: { userId: string; organizationId: string },
): Promise<ClientView[]> {
  const tokenRows = await db
    .select({ id: mcpTokens.id })
    .from(mcpTokens)
    .where(and(eq(mcpTokens.userId, opts.userId), eq(mcpTokens.organizationId, opts.organizationId)));
  if (tokenRows.length === 0) return [];
  const rows = await db
    .select()
    .from(mcpClients)
    .where(inArray(mcpClients.tokenId, tokenRows.map((t) => t.id)))
    .orderBy(desc(mcpClients.lastSeenAt));
  return rows.map((c) => ({
    id: c.id,
    tokenId: c.tokenId,
    clientName: c.clientName,
    clientVersion: c.clientVersion,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
  }));
}

/** Upsert a connected-client record from the MCP initialize clientInfo. */
export async function trackMcpClient(
  db: Database,
  opts: { tokenId: string; clientName: string; clientVersion?: string },
): Promise<void> {
  const existing = await db
    .select()
    .from(mcpClients)
    .where(and(eq(mcpClients.tokenId, opts.tokenId), eq(mcpClients.clientName, opts.clientName)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(mcpClients)
      .set({ lastSeenAt: new Date(), clientVersion: opts.clientVersion ?? existing[0].clientVersion })
      .where(eq(mcpClients.id, existing[0].id));
    return;
  }
  await db.insert(mcpClients).values({
    tokenId: opts.tokenId,
    clientName: opts.clientName,
    clientVersion: opts.clientVersion ?? null,
  });
}

/**
 * Fixed-window rate limit per token (default 120 req/min per API.md).
 * Throws RATE_LIMITED with a Retry-After when the window is exhausted.
 */
export async function checkTokenRateLimit(
  redis: { incr: (k: string) => Promise<number>; expire: (k: string, s: number) => Promise<unknown> },
  tokenId: string,
  limitPerMinute: number,
): Promise<void> {
  const key = `rl:mcp-token:${tokenId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  if (count > limitPerMinute) {
    const seconds = Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60));
    throw rateLimited(seconds);
  }
}
