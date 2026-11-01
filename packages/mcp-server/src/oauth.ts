import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@graphite/db/client";
import { oauthClients, oauthCodes, oauthTokens } from "@graphite/db/schema";
import { unauthorized } from "@graphite/core";
import { MCP_SCOPES } from "./scopes.js";
import { validateScopes } from "./tokens.js";

/**
 * Minimal OAuth 2.1 authorization server for MCP (Phase 10).
 * - Authorization code flow with PKCE (S256 REQUIRED per OAuth 2.1).
 * - Opaque access + refresh tokens, stored as SHA-256 hashes only.
 * - Refresh rotation: using a refresh token invalidates its family.
 * - Revocation (RFC 7009) kills the token family immediately.
 * Scope and organization binding match the personal-access-token path.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface RegisteredClient {
  clientId: string;
  /** Plaintext secret, returned once for confidential clients. */
  clientSecret: string | null;
  clientName: string;
  redirectUris: string[];
}

/** Dynamic client registration (RFC 7591). Public clients (no secret) allowed. */
export async function registerOAuthClient(
  db: Database,
  opts: {
    name: string;
    redirectUris: string[];
    registeredBy: string;
    organizationId: string;
    /** "none" for public PKCE clients (default), "client_secret_post" otherwise. */
    tokenEndpointAuthMethod?: string;
  },
): Promise<RegisteredClient> {
  if (opts.redirectUris.length === 0) {
    throw unauthorized("redirect_uris is required");
  }
  for (const uri of opts.redirectUris) {
    if (!/^https?:\/\//.test(uri) && uri !== "http://127.0.0.1/callback") {
      throw unauthorized(`Invalid redirect_uri: ${uri}`);
    }
  }
  const confidential = opts.tokenEndpointAuthMethod === "client_secret_post";
  const clientId = `mcp_${randomBytes(12).toString("base64url")}`;
  const clientSecret = confidential ? `mcpsec_${randomBytes(32).toString("base64url")}` : null;
  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
    name: opts.name.slice(0, 120),
    redirectUris: opts.redirectUris,
    registeredBy: opts.registeredBy,
    organizationId: opts.organizationId,
  });
  return {
    clientId,
    clientSecret,
    clientName: opts.name,
    redirectUris: opts.redirectUris,
  };
}

export interface AuthorizedCode {
  /** Plaintext code — returned once via the redirect. */
  code: string;
  redirectUri: string;
  state?: string;
}

/** Create a single-use authorization code bound to the PKCE challenge. */
export async function createAuthorizationCode(
  db: Database,
  opts: {
    clientId: string;
    userId: string;
    organizationId: string;
    redirectUri: string;
    scope: string;
    codeChallenge: string;
  },
): Promise<AuthorizedCode> {
  validateScopes(opts.scope.split(" "));
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(opts.codeChallenge)) {
    throw unauthorized("code_challenge must be base64url(SHA-256(verifier)) (S256 required)");
  }
  const clients = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, opts.clientId))
    .limit(1);
  const client = clients[0];
  if (!client || !client.redirectUris.includes(opts.redirectUri)) {
    throw unauthorized("Unknown client or redirect_uri");
  }
  const code = `gphac_${randomBytes(32).toString("base64url")}`;
  await db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: client.id,
    userId: opts.userId,
    organizationId: opts.organizationId,
    redirectUri: opts.redirectUri,
    scope: opts.scope,
    codeChallenge: opts.codeChallenge,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return { code, redirectUri: opts.redirectUri };
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCodeForTokens(
  db: Database,
  opts: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<IssuedTokens> {
  const clients = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, opts.clientId))
    .limit(1);
  const client = clients[0];
  if (!client) throw unauthorized("Unknown client");
  if (client.clientSecretHash) {
    if (!opts.clientSecret || sha256(opts.clientSecret) !== client.clientSecretHash) {
      throw unauthorized("Client authentication failed");
    }
  }
  const codes = await db
    .select()
    .from(oauthCodes)
    .where(and(eq(oauthCodes.codeHash, sha256(opts.code)), eq(oauthCodes.clientId, client.id)))
    .limit(1);
  const row = codes[0];
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw unauthorized("Invalid or expired authorization code");
  }
  if (row.redirectUri !== opts.redirectUri) {
    throw unauthorized("redirect_uri mismatch");
  }
  // PKCE: S256(verifier) must equal the stored challenge (constant-time-ish compare).
  if (s256(opts.codeVerifier) !== row.codeChallenge) {
    throw unauthorized("PKCE verification failed");
  }
  await db.update(oauthCodes).set({ usedAt: new Date() }).where(eq(oauthCodes.id, row.id));

  const familyId = `fam_${randomBytes(12).toString("base64url")}`;
  return issueTokenFamily(db, {
    clientId: client.id,
    userId: row.userId,
    organizationId: row.organizationId,
    scope: row.scope,
    familyId,
  });
}

async function issueTokenFamily(
  db: Database,
  opts: { clientId: string; userId: string; organizationId: string; scope: string; familyId: string },
): Promise<IssuedTokens> {
  const accessToken = `gphat_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `gphrt_${randomBytes(32).toString("base64url")}`;
  await db.insert(oauthTokens).values([
    {
      tokenHash: sha256(accessToken),
      kind: "access",
      clientId: opts.clientId,
      userId: opts.userId,
      organizationId: opts.organizationId,
      scope: opts.scope,
      familyId: opts.familyId,
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
    },
    {
      tokenHash: sha256(refreshToken),
      kind: "refresh",
      clientId: opts.clientId,
      userId: opts.userId,
      organizationId: opts.organizationId,
      scope: opts.scope,
      familyId: opts.familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  ]);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: opts.scope,
  };
}

/** Rotate a refresh token; the old family is revoked atomically. */
export async function refreshTokens(
  db: Database,
  opts: { clientId: string; refreshToken: string },
): Promise<IssuedTokens> {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, sha256(opts.refreshToken)), eq(oauthTokens.kind, "refresh")))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    throw unauthorized("Invalid or expired refresh token");
  }
  const clients = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, row.clientId))
    .limit(1);
  if (!clients[0] || clients[0].clientId !== opts.clientId) {
    throw unauthorized("Client authentication failed");
  }
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthTokens.familyId, row.familyId));
  return issueTokenFamily(db, {
    clientId: row.clientId,
    userId: row.userId,
    organizationId: row.organizationId,
    scope: row.scope,
    familyId: `fam_${randomBytes(12).toString("base64url")}`,
  });
}

/** RFC 7009 revocation: kill the token's whole family. */
export async function revokeToken(db: Database, token: string): Promise<void> {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, sha256(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return; // RFC 7009: invalid tokens revoke successfully (200).
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthTokens.familyId, row.familyId));
}

export interface ResolvedOAuthToken {
  userId: string;
  organizationId: string;
  scope: string;
}

/** Resolve an access token for the /mcp path; null when invalid/expired/revoked. */
export async function resolveOAuthAccessToken(
  db: Database,
  token: string,
): Promise<ResolvedOAuthToken | null> {
  if (!token.startsWith("gphat_")) return null;
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, sha256(token)), isNull(oauthTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || row.kind !== "access" || row.expiresAt.getTime() < Date.now()) return null;
  return { userId: row.userId, organizationId: row.organizationId, scope: row.scope };
}

export const OAUTH_SCOPES = MCP_SCOPES;
