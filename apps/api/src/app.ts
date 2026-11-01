import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { isAppError, logger, notFound, withTimeout, type AppError } from "@graphite/core";
import { parseAllowedOrigins } from "@graphite/core/config";
import { httpRequestDuration, renderMetrics } from "@graphite/telemetry/metrics";
import { createContext, type AppDeps, type SessionUser } from "./context";
import { appRouter } from "./routers/index";
import { invitationsRestRouter } from "./rest/invitations";
import { integrationsRestRouter } from "./rest/integrations";
import { datasetsRestRouter } from "./rest/datasets";
import { datasetRestRouter } from "./rest/datasets-query";
import { eventsRestRouter } from "./rest/events";
import { publicRestRouter } from "./rest/public";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Queue } from "bullmq";
import { createMcpRouter, type McpRouterDeps } from "@graphite/mcp-server/server";

interface AuthedRequest extends Request {
  graphiteUser?: SessionUser | null;
}

export interface CreatedApp {
  app: Express;
  deps: AppDeps;
}

export interface RestExtras {
  storage: S3Client;
  bucket: string;
  ingestionQueue: Queue;
  maxUploadMb: number;
  dataGrpcAddress: string;
  maxQueryRows: number;
  statementTimeoutMs: number;
}

export interface AppOptions {
  allowedOrigins?: string[];
  rest?: RestExtras;
  /** External MCP mount at /mcp (Streamable HTTP, PAT auth). */
  mcp?: McpRouterDeps;
}

/**
 * Build the API app. All service handles are injected so tests can run the
 * app against isolated databases and Redis instances.
 */
export function createApp(
  deps: AppDeps,
  opts?: AppOptions,
): CreatedApp {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Explicit, configurable browser origins (CORS_ORIGINS); never a wildcard
  // because credentials (session cookies) are always enabled.
  const origins = opts?.allowedOrigins ?? parseAllowedOrigins(process.env.CORS_ORIGINS);
  app.use(
    cors({
      origin: origins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  // Request id for every response.
  app.use((req, res, next) => {
    const requestId = (req.headers["x-request-id"] as string) || `req_${crypto.randomUUID()}`;
    res.setHeader("x-request-id", requestId);
    res.locals.requestId = requestId;
    next();
  });

  // Prometheus request duration (route label = first path segment pattern to
  // bound cardinality).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const route = req.path.startsWith("/api/auth")
        ? "/api/auth/*"
        : `/${req.path.split("/").slice(1, 4).join("/") || ""}`;
      httpRequestDuration
        .labels(req.method, route, String(res.statusCode))
        .observe(Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  });

  // Health endpoints (no auth).
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "api" });
  });

  // Prometheus metrics.
  app.get("/metrics", async (_req, res) => {
    try {
      res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(await renderMetrics());
    } catch {
      res.status(500).end();
    }
  });

  app.get("/readyz", async (_req, res) => {
    const checks: Record<string, "ok" | "down"> = { postgres: "down", redis: "down" };
    try {
      await withTimeout(deps.sql`SELECT 1`, 2000);
      checks.postgres = "ok";
    } catch {
      // keep down
    }
    try {
      const pong = await withTimeout(deps.redis.ping(), 2000);
      if (pong === "PONG") checks.redis = "ok";
    } catch {
      // keep down
    }
    const ready = Object.values(checks).every((v) => v === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "down", checks });
  });

  // External MCP server at /mcp (Streamable HTTP, stateless): personal access
  // token auth; shares tool implementations with the worker's internal mount.
  if (opts?.mcp) {
    app.use(createMcpRouter(opts.mcp));
  }

  // Better Auth handles /api/auth/* (sign-up, sign-in, sign-out, session).
  if (deps.auth) {
    app.use("/api/auth", (req, res, next) => {
      void Promise.resolve(deps.auth?.handler(req, res)).catch(next);
    });
  }

  // Session middleware: resolves the user for downstream routers.
  app.use(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      req.graphiteUser = deps.auth
        ? await deps.auth.resolveSession(req.headers)
        : null;
      next();
    } catch (e) {
      next(e);
    }
  });

  // Per-user API rate limit (API.md: 300 req/min default). Applies to
  // /api/v1 and /trpc for session callers; 0 disables. Read per request so
  // tests (and ops) can tune it without a restart.
  app.use(async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const userLimit = Number(process.env.USER_REQUESTS_PER_MIN ?? 300);
      if (
        userLimit <= 0 ||
        !req.graphiteUser ||
        (!req.path.startsWith("/api") && !req.path.startsWith("/trpc"))
      ) {
        next();
        return;
      }
      const key = `rl:user:${req.graphiteUser.id}:${Math.floor(Date.now() / 60_000)}`;
      const count = await deps.redis.incr(key);
      if (count === 1) await deps.redis.expire(key, 120);
      if (count > userLimit) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({
          error: {
            code: "RATE_LIMITED",
            message: `Rate limit exceeded (${userLimit} req/min)`,
            requestId: String(res.getHeader("x-request-id") ?? ""),
            details: {},
          },
        });
        return;
      }
      next();
    } catch {
      next(); // rate limiter must not break traffic
    }
  });

  // REST routers (AppError -> API.md JSON via the error handler below).
  app.use("/api/v1", invitationsRestRouter(deps));
  app.use("/api/v1", eventsRestRouter(deps));
  app.use("/api/v1", integrationsRestRouter(deps));
  app.use("/api/v1", publicRestRouter(deps));
  if (opts?.rest) {
    app.use(
      "/api/v1",
      datasetsRestRouter({
        db: deps.db,
        sql: deps.sql,
        auth: deps.auth,
        storage: opts.rest.storage,
        bucket: opts.rest.bucket,
        ingestionQueue: opts.rest.ingestionQueue,
        maxUploadMb: opts.rest.maxUploadMb,
      }),
    );
    app.use(
      "/api/v1",
      datasetRestRouter({
        db: deps.db,
        auth: deps.auth,
        dataGrpcAddress: opts.rest.dataGrpcAddress,
        maxQueryRows: opts.rest.maxQueryRows,
        statementTimeoutMs: opts.rest.statementTimeoutMs,
      }),
    );
  }

  // tRPC mounted at /trpc.
  app.use(
    "/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: ({ req, res }) => {
        const authedReq = req as AuthedRequest;
        const requestId =
          (res.locals.requestId as string | undefined) ?? `req_${crypto.randomUUID()}`;
        return createContext(deps, {
          requestId,
          headers: req.headers,
          user: authedReq.graphiteUser ?? null,
        });
      },
      onError: (o) => {
        const e = o.error;
        logger[isAppError(e.cause) ? "warn" : "error"](
          { path: o.path, code: e.code, err: e.cause ?? e },
          "trpc error",
        );
      },
    }),
  );

  // Unknown REST routes use the API.md error format.
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(notFound());
  });

  // REST error handler: maps AppError to the API.md error format.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      const status: Record<AppError["code"], number> = {
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
      if (err.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
      }
      res.status(status[err.code]).json({
        error: {
          code: err.code,
          message: err.message,
          requestId: String(res.getHeader("x-request-id") ?? ""),
          details: err.details ?? {},
        },
      });
      return;
    }
    logger.error({ err }, "unhandled error");
    res.status(500).json({
      error: {
        code: "INTERNAL",
        message: "Unexpected error",
        requestId: String(res.getHeader("x-request-id") ?? ""),
        details: {},
      },
    });
  });

  return { app, deps };
}
