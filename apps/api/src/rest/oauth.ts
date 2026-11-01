import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { isAppError } from "@graphite/core";
import {
  createAuthorizationCode,
  exchangeCodeForTokens,
  OAUTH_SCOPES,
  refreshTokens,
  registerOAuthClient,
  revokeToken,
} from "@graphite/mcp-server/oauth";
import type { AppDeps } from "../context";

/**
 * OAuth 2.1 for MCP (Phase 10) — minimal authorization server, per API.md:
 * - GET  /.well-known/oauth-protected-resource   (RFC 9728)
 * - GET  /.well-known/oauth-authorization-server (RFC 8414)
 * - POST /oauth/register     dynamic client registration (RFC 7591)
 * - GET  /oauth/authorize    authorization code + PKCE (S256 required)
 * - POST /oauth/token        code exchange and refresh_token grant
 * - POST /oauth/revoke       RFC 7009
 */
export function oauthRestRouter(deps: AppDeps): Router {
  const r = Router();

  const issuer = process.env.API_URL ?? "http://localhost:4000";

  r.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: `${issuer}/mcp`,
      resource_documentation: `${issuer}`,
      authorization_servers: [issuer],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods: ["header"],
    });
  });

  r.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: OAUTH_SCOPES,
    });
  });

  const oauthError = (res: Response, e: unknown): void => {
    if (isAppError(e)) {
      const status = e.code === "UNAUTHORIZED" ? 400 : 400; // token endpoint errors are 400 per RFC 6749 §5.2
      res.status(status).json({
        error: "invalid_request",
        error_description: e.message,
      });
      return;
    }
    throw e;
  };

  // Dynamic client registration. Requires a session; the client is bound to
  // the registering user's organization so tokens resolve to one tenant.
  r.post("/oauth/register", async (req: Request, res: Response) => {
    try {
      const user = deps.auth ? await deps.auth.resolveSession(req.headers) : null;
      if (!user) {
        res.status(401).json({ error: "invalid_token", error_description: "Sign in required" });
        return;
      }
      const parsed = z
        .object({
          client_name: z.string().min(1).max(120),
          redirect_uris: z.array(z.string().min(1).max(500)).min(1).max(5),
          token_endpoint_auth_method: z.enum(["none", "client_secret_post"]).optional(),
          scope: z.string().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_client_metadata", error_description: "Invalid registration" });
        return;
      }
      const orgId = (req.body as { organizationId?: string }).organizationId;
      if (!orgId) {
        res.status(400).json({ error: "invalid_client_metadata", error_description: "organizationId is required (tenant binding)" });
        return;
      }
      const created = await registerOAuthClient(deps.db, {
        name: parsed.data.client_name,
        redirectUris: parsed.data.redirect_uris,
        registeredBy: user.id,
        organizationId: orgId,
        tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
      });
      res.status(201).json({
        client_id: created.clientId,
        client_secret: created.clientSecret ?? undefined,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: created.clientName,
        redirect_uris: created.redirectUris,
        token_endpoint_auth_method: parsed.data.token_endpoint_auth_method ?? "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: OAUTH_SCOPES.join(" "),
      });
    } catch (e) {
      oauthError(res, e);
    }
  });

  // Authorization endpoint (browser session required). PKCE S256 required.
  r.get("/oauth/authorize", async (req: Request, res: Response) => {
    try {
      const user = deps.auth ? await deps.auth.resolveSession(req.headers) : null;
      if (!user) {
        res.status(401).json({ error: "invalid_token", error_description: "Sign in to authorize" });
        return;
      }
      const q = req.query as Record<string, string | undefined>;
      if (q.response_type !== "code") {
        res.status(400).json({ error: "unsupported_response_type" });
        return;
      }
      if (q.code_challenge_method !== "S256" || !q.code_challenge) {
        res.status(400).json({ error: "invalid_request", error_description: "PKCE S256 is required" });
        return;
      }
      const scope = q.scope ?? OAUTH_SCOPES.join(" ");
      const orgId = q.organizationId;
      if (!orgId) {
        res.status(400).json({ error: "invalid_request", error_description: "organizationId is required (tenant binding)" });
        return;
      }
      if (!q.client_id || !q.redirect_uri) {
        res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri required" });
        return;
      }
      const issued = await createAuthorizationCode(deps.db, {
        clientId: q.client_id,
        userId: user.id,
        organizationId: orgId,
        redirectUri: q.redirect_uri,
        scope,
        codeChallenge: q.code_challenge,
      });
      const url = new URL(issued.redirectUri);
      url.searchParams.set("code", issued.code);
      if (q.state) url.searchParams.set("state", q.state);
      res.redirect(url.toString());
    } catch (e) {
      oauthError(res, e);
    }
  });

  // Token endpoint: authorization_code (+ PKCE verifier) or refresh_token.
  r.post("/oauth/token", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.code_verifier || !body.client_id || !body.redirect_uri) {
          res.status(400).json({ error: "invalid_request", error_description: "Missing parameters" });
          return;
        }
        const tokens = await exchangeCodeForTokens(deps.db, {
          clientId: body.client_id,
          clientSecret: body.client_secret,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
        });
        res.json(tokens);
        return;
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token || !body.client_id) {
          res.status(400).json({ error: "invalid_request", error_description: "Missing parameters" });
          return;
        }
        const tokens = await refreshTokens(deps.db, {
          clientId: body.client_id,
          refreshToken: body.refresh_token,
        });
        res.json(tokens);
        return;
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    } catch (e) {
      if (isAppError(e)) {
        res.status(400).json({ error: "invalid_grant", error_description: e.message });
        return;
      }
      throw e;
    }
  });

  // RFC 7009 revocation. Unauthenticated per RFC (client id in body).
  r.post("/oauth/revoke", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { token?: string; client_id?: string };
      if (!body.token) {
        res.status(400).json({ error: "invalid_request", error_description: "token required" });
        return;
      }
      await revokeToken(deps.db, body.token);
      res.status(200).json({});
    } catch (e) {
      if (isAppError(e)) {
        res.status(400).json({ error: "invalid_request", error_description: e.message });
        return;
      }
      throw e;
    }
  });

  return r;
}
