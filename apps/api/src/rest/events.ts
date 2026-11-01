import { Router, type Request, type Response } from "express";
import type Redis from "ioredis";
import { datasetEventsChannel, runEventsChannel } from "@graphite/core";
import { datasets, agentRuns } from "@graphite/db/schema";
import { eq } from "drizzle-orm";
import type { Database } from "@graphite/db/client";
import type { GraphiteAuth } from "../auth.js";
import { resolveRestUser, requireRestAuthorized } from "./auth.js";

/**
 * Server-Sent Events for ingestion progress and agent run streams.
 * Events are published to Redis by workers and MCP tools; any API instance
 * holding the subscriber relays them, which keeps multi-instance deployments
 * working.
 */
export function eventsRestRouter(deps: {
  db: Database;
  redis: Redis;
  auth?: GraphiteAuth;
}): Router {
  const r = Router();

  const sseHeaders = (res: Response): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
  };

  const streamChannel = (
    req: Request,
    res: Response,
    channel: string,
  ): void => {
    const sub = deps.redis.duplicate();
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void sub.unsubscribe(channel).catch(() => undefined);
      sub.disconnect();
      res.end();
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, 15_000);

    void sub.subscribe(channel).then(() => {
      sub.on("message", (_ch, message) => {
        if (closed) return;
        // The message is already a JSON event envelope from the publisher.
        let event = "message";
        let payload = message;
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: unknown };
          if (parsed.type) {
            event = parsed.type;
            payload = JSON.stringify(parsed.data ?? {});
          }
        } catch {
          // forward raw
        }
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
      });
    });

    req.on("close", finish);
  };

  // GET /api/v1/datasets/:datasetId/events — ingestion progress (viewer+).
  r.get("/datasets/:datasetId/events", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} },
        });
        return;
      }
      const dsId = String(req.params.datasetId ?? "");
      const rows = await deps.db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1);
      const ds = rows[0];
      if (!ds || ds.deletedAt) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "Dataset not found", requestId: "", details: {} },
        });
        return;
      }
      await requireRestAuthorized(deps.db, user, ds.organizationId, "dataset:read", {
        type: "dataset",
      });
      sseHeaders(res);
      streamChannel(req, res, datasetEventsChannel(dsId));
    } catch (e) {
      next(e);
    }
  });

  // GET /api/v1/runs/:runId/events — live agent run events (viewer+).
  r.get("/runs/:runId/events", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} },
        });
        return;
      }
      const runId = String(req.params.runId ?? "");
      const rows = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
      const run = rows[0];
      if (!run) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "Run not found", requestId: "", details: {} },
        });
        return;
      }
      await requireRestAuthorized(deps.db, user, run.organizationId, "dashboard:read", {
        type: "run",
      });
      sseHeaders(res);
      streamChannel(req, res, runEventsChannel(runId));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
