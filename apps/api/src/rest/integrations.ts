import { Router, type Request } from "express";
import { isAppError } from "@graphite/core";
import {
  createMcpToken,
  listMcpClients,
  listMcpTokens,
  revokeMcpToken,
} from "@graphite/mcp-server/tokens";
import { MCP_SCOPES } from "@graphite/mcp-server/scopes";
import { z } from "zod";
import type { AppDeps, Context, SessionUser } from "../context";
import { requireAuthorized } from "../authz-helpers";

interface AuthedRequest extends Request {
  graphiteUser?: SessionUser | null;
}

/**
 * REST: Integrations endpoints (API.md §Integrations).
 * GET    /api/v1/orgs/:orgId/mcp/tokens          — list own tokens
 * POST   /api/v1/orgs/:orgId/mcp/tokens          — create (plaintext shown once)
 * DELETE /api/v1/orgs/:orgId/mcp/tokens/:tokenId — revoke
 * GET    /api/v1/orgs/:orgId/mcp/clients         — connected MCP clients
 */
export function integrationsRestRouter(deps: AppDeps): Router {
  const r = Router();

  const error = (res: import("express").Response, e: unknown): void => {
    if (isAppError(e)) {
      const status: Record<string, number> = {
        BAD_REQUEST: 400,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        PAYLOAD_TOO_LARGE: 413,
        UNPROCESSABLE: 422,
        RATE_LIMITED: 429,
        QUOTA_EXCEEDED: 429,
        INTERNAL: 500,
      };
      if (e.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(e.retryAfterSeconds));
      }
      res.status(status[e.code] ?? 500).json({
        error: {
          code: e.code,
          message: e.message,
          requestId: String(res.getHeader("x-request-id") ?? ""),
          details: e.details ?? {},
        },
      });
      return;
    }
    throw e;
  };

  // Minimal Context for requireAuthorized (actor resolution only).
  const ctxFor = (req: AuthedRequest): Context => {
    const user = req.graphiteUser!;
    return {
      requestId: String(req.headers["x-request-id"] ?? ""),
      user,
      headers: req.headers,
      db: deps.db,
      sql: deps.sql,
      redis: deps.redis,
      getDataClient: deps.getDataClient,
      enqueueAgentRun: deps.enqueueAgentRun,
      actorFor: async (orgId: string) => {
        const role = await deps.resolveMembershipRole(user, orgId);
        if (!role) return null;
        return { userId: user.id, orgId, role };
      },
    };
  };

  r.use("/orgs/:orgId/mcp", async (req: AuthedRequest, res, next) => {
    try {
      const user = deps.auth ? await deps.auth.resolveSession(req.headers) : null;
      if (!user) {
        res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Sign in required",
            requestId: String(res.getHeader("x-request-id") ?? ""),
            details: {},
          },
        });
        return;
      }
      req.graphiteUser = user;
      next();
    } catch (e) {
      next(e);
    }
  });

  r.get("/orgs/:orgId/mcp/tokens", async (req: AuthedRequest, res, next) => {
    try {
      const orgId = String(req.params.orgId);
      await requireAuthorized(ctxFor(req), orgId, "token:read", { type: "token" });
      res.json({
        tokens: await listMcpTokens(deps.db, {
          userId: req.graphiteUser!.id,
          organizationId: orgId,
        }),
      });
    } catch (e) {
      error(res, e) ?? next(e);
    }
  });

  r.post("/orgs/:orgId/mcp/tokens", async (req: AuthedRequest, res, next) => {
    try {
      const orgId = String(req.params.orgId);
      const parsed = z
        .object({
          name: z.string().min(1).max(100),
          scopes: z.array(z.enum(MCP_SCOPES)).min(1),
          expiresInDays: z.number().int().min(1).max(3650).nullish(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "BAD_REQUEST",
            message: "Invalid token request",
            requestId: String(res.getHeader("x-request-id") ?? ""),
            details: { issues: parsed.error.issues.map((i) => i.message) },
          },
        });
        return;
      }
      await requireAuthorized(
        ctxFor(req),
        orgId,
        "token:write",
        { type: "token", ownerId: req.graphiteUser!.id },
      );
      const created = await createMcpToken(deps.db, {
        userId: req.graphiteUser!.id,
        organizationId: orgId,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        expiresInDays: parsed.data.expiresInDays ?? null,
      });
      res.status(201).json({
        id: created.id,
        // Plaintext shown exactly once.
        token: created.token,
        prefix: created.prefix,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
      });
    } catch (e) {
      error(res, e) ?? next(e);
    }
  });

  r.delete("/orgs/:orgId/mcp/tokens/:tokenId", async (req: AuthedRequest, res, next) => {
    try {
      const orgId = String(req.params.orgId);
      await requireAuthorized(
        ctxFor(req),
        orgId,
        "token:write",
        { type: "token", ownerId: req.graphiteUser!.id },
      );
      await revokeMcpToken(deps.db, {
        tokenId: String(req.params.tokenId),
        userId: req.graphiteUser!.id,
        organizationId: orgId,
      });
      res.json({ ok: true });
    } catch (e) {
      error(res, e) ?? next(e);
    }
  });

  r.get("/orgs/:orgId/mcp/clients", async (req: AuthedRequest, res, next) => {
    try {
      const orgId = String(req.params.orgId);
      await requireAuthorized(ctxFor(req), orgId, "token:read", { type: "token" });
      res.json({
        clients: await listMcpClients(deps.db, {
          userId: req.graphiteUser!.id,
          organizationId: orgId,
        }),
      });
    } catch (e) {
      error(res, e) ?? next(e);
    }
  });

  return r;
}
