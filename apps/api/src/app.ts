import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { isAppError, logger, notFound, withTimeout, type AppError } from "@graphite/core";
import { createContext, type AppDeps, type SessionUser } from "./context.js";
import { appRouter } from "./routers/index.js";
import { invitationsRestRouter } from "./rest/invitations.js";
import { datasetsRestRouter } from "./rest/datasets.js";
import { datasetRestRouter } from "./rest/datasets-query.js";
import { eventsRestRouter } from "./rest/events.js";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Queue } from "bullmq";

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

/**
 * Build the API app. All service handles are injected so tests can run the
 * app against isolated databases and Redis instances.
 */
export function createApp(
  deps: AppDeps,
  opts?: { allowedOrigins?: string[]; rest?: RestExtras },
): CreatedApp {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const origins = opts?.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"];
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

  // Health endpoints (no auth).
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "api" });
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

  // REST routers (AppError -> API.md JSON via the error handler below).
  app.use("/api/v1", invitationsRestRouter(deps));
  app.use("/api/v1", eventsRestRouter(deps));
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
