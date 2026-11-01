import { z } from "zod";
import { childLogger } from "@graphite/core";
import { loadRootEnv, parseEnv } from "@graphite/core/config";
import { startTelemetry } from "@graphite/telemetry";
import { renderMetrics } from "@graphite/telemetry/metrics";
import { createDb } from "@graphite/db/client";
import express from "express";
import { ServerCredentials } from "@grpc/grpc-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDataService } from "./service";

loadRootEnv();
const log = childLogger({ component: "data" });
const dir = path.dirname(fileURLToPath(import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  /** Read-only role connection; all user-visible SQL runs here. */
  DATABASE_READONLY_URL: z.string().min(1),
  DATA_GRPC_PORT: z.coerce.number().int().default(50051),
  DATA_HEALTH_PORT: z.coerce.number().int().default(50052),
  MAX_QUERY_ROWS: z.coerce.number().int().default(5000),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(10_000),
});

const env = parseEnv(envSchema);

async function main(): Promise<void> {
  startTelemetry({ serviceName: "graphite-data" });
  // Metadata pool runs as the app role (resolving dataset ids to tables);
  // user-visible SQL runs exclusively through the read-only role pool.
  const { sql } = createDb(env.DATABASE_URL);
  const readonly = createDb(env.DATABASE_READONLY_URL, { max: 5 });

  const { server } = createDataService({
    metadataSql: sql,
    readonlySql: readonly.sql,
    protoPath: path.join(dir, "..", "proto", "data.proto"),
    maxQueryRows: env.MAX_QUERY_ROWS,
    statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
  });

  server.bindAsync(`0.0.0.0:${env.DATA_GRPC_PORT}`, ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      log.error({ err }, "gRPC bind failed");
      process.exit(1);
    }
    log.info({ port }, "data service (gRPC) listening");
  });

  // HTTP health surface.
  const health = express();
  health.disable("x-powered-by");
  health.get("/healthz", (_req, res) => res.json({ status: "ok", service: "data" }));
  health.get("/metrics", async (_req, res) => {
    try {
      res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(await renderMetrics());
    } catch {
      res.status(500).end();
    }
  });
  health.listen(env.DATA_HEALTH_PORT, () => {
    log.info({ port: env.DATA_HEALTH_PORT }, "data service health listening");
  });
}

main().catch((e) => {
  log.error({ err: e }, "fatal data service startup error");
  process.exit(1);
});
