import { z } from "zod";
import { childLogger, withTimeout } from "@graphite/core";
import { loadRootEnv, parseEnv } from "@graphite/core/config";
import express from "express";
import { createDb } from "@graphite/db/client";
import Redis from "ioredis";

loadRootEnv();
const log = childLogger({ component: "worker" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(4001),
});

const env = parseEnv(envSchema);

async function main(): Promise<void> {
  const { sql } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await redis.connect();

  // Health endpoint: the worker's "hello world" surface for Phase 0.
  const health = express();
  health.disable("x-powered-by");
  health.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "worker", workers: [] });
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
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "down", checks: { postgres, redis: redisOk } });
  });
  health.listen(env.WORKER_HEALTH_PORT, () => {
    log.info({ port: env.WORKER_HEALTH_PORT }, "worker health endpoint listening");
  });

  // BullMQ workers (ingestion, agent-run) are registered in their phases.
  log.info("worker booted with no queues yet");
}

main().catch((e) => {
  log.error({ err: e }, "fatal worker startup error");
  process.exit(1);
});
