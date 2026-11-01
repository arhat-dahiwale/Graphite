import { z } from "zod";
import { childLogger, withTimeout } from "@graphite/core";
import { loadRootEnv, parseEnv } from "@graphite/core/config";
import { createDb } from "@graphite/db/client";
import express from "express";
import Redis from "ioredis";
import { createStorage, ensureBucket } from "@graphite/storage";
import { startIngestionWorker } from "./queues/ingestion.js";

loadRootEnv();
const log = childLogger({ component: "worker" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(4001),
  S3_ENDPOINT: z.string().default("http://localhost:9002"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("graphite-uploads"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  INGESTION_CONCURRENCY: z.coerce.number().int().default(1),
});

const env = parseEnv(envSchema);

async function main(): Promise<void> {
  const { sql, db } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await redis.connect();

  const storage = createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  await ensureBucket(storage, env.S3_BUCKET);

  const workers = [
    startIngestionWorker({
      connection: redis,
      db,
      sql,
      storage,
      bucket: env.S3_BUCKET,
      concurrency: env.INGESTION_CONCURRENCY,
    }),
  ];

  // Health endpoint: the worker's operational surface.
  const health = express();
  health.disable("x-powered-by");
  health.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "worker",
      workers: workers.map((w) => ({ name: w.name, isRunning: w.isRunning() })),
    });
  });
  health.get("/readyz", async (_req, res) => {
    let postgres = "down";
    let redisOk = "down";
    try {
      await withTimeout(sql`SELECT 1`, 2000);
      postgres = "ok";
    } catch {
      // stay down
    }
    try {
      if ((await redis.ping()) === "PONG") redisOk = "ok";
    } catch {
      // stay down
    }
    const ready = postgres === "ok" && redisOk === "ok";
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ok" : "down", checks: { postgres, redis: redisOk } });
  });
  health.listen(env.WORKER_HEALTH_PORT, () => {
    log.info({ port: env.WORKER_HEALTH_PORT }, "worker health endpoint listening");
  });

  log.info({ queues: workers.map((w) => w.name) }, "worker booted");
}

main().catch((e) => {
  log.error({ err: e }, "fatal worker startup error");
  process.exit(1);
});
