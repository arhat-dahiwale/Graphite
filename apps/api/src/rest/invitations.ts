import { Router } from "express";
import { acceptInvitation } from "@graphite/db/repo/invitations";
import type { AppDeps } from "../context.js";

/**
 * REST: POST /api/v1/invitations/:token/accept (API.md).
 * Requires a session; the signed-in user must match the invited email.
 */
export function invitationsRestRouter(deps: AppDeps): Router {
  const r = Router();

  r.post("/invitations/:token/accept", async (req, res, next) => {
    try {
      const user = deps.auth ? await deps.auth.resolveSession(req.headers) : null;
      if (!user) {
        res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Sign in to accept an invitation",
            requestId: String(res.getHeader("x-request-id") ?? ""),
            details: {},
          },
        });
        return;
      }
      const token = String(req.params.token ?? "");
      const result = await acceptInvitation(deps.db, token, user.id, user.email);
      if (!result.ok) {
        if (result.reason === "not_found") {
          res.status(404).json({
            error: {
              code: "NOT_FOUND",
              message: "Invitation not found",
              requestId: String(res.getHeader("x-request-id") ?? ""),
              details: {},
            },
          });
          return;
        }
        if (result.reason === "expired") {
          res.status(422).json({
            error: {
              code: "UNPROCESSABLE",
              message: "Invitation expired",
              requestId: String(res.getHeader("x-request-id") ?? ""),
              details: {},
            },
          });
          return;
        }
        res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "This invitation was sent to a different email address",
            requestId: String(res.getHeader("x-request-id") ?? ""),
            details: {},
          },
        });
        return;
      }
      res.json({ organizationId: result.organizationId, role: result.role });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
