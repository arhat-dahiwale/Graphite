import { z } from "zod";
import { childLogger, withTimeout } from "@graphite/core";
import { loadRootEnv, parseEnv } from "@graphite/core/config";
import { startTelemetry } from "@graphite/telemetry";
import { registry, renderMetrics } from "@graphite/telemetry/metrics";
import client from "prom-client";
import { createDb } from "@graphite/db/client";
import express from "express";
import Redis from "ioredis";
import { createStorage, ensureBucket } from "@graphite/storage";
import { createDataClient, type DataClient } from "@graphite/data/client";
import { createMcpRouter } from "@graphite/mcp-server/server";
import { startIngestionWorker } from "./queues/ingestion";
import { startAgentRunWorker } from "./queues/agent-run";

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
  AGENT_TOKEN_BUDGET: z.coerce.number().int().default(200_000),
  AGENT_RUN_CONCURRENCY: z.coerce.number().int().default(2),
  LLM_PROVIDER: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  DATA_GRPC_HOST: z.string().default("127.0.0.1"),
  DATA_GRPC_PORT: z.string().default("50051"),
  // Signs the internal MCP identity headers. No default: a missing or weak
  // secret must fail startup, not weaken identity verification.
  INTERNAL_MCP_SECRET: z.string().min(32),
  WORKER_INTERNAL_MCP_PORT: z.coerce.number().int().default(4100),
});

const env = parseEnv(envSchema);

async function main(): Promise<void> {
  startTelemetry({ serviceName: "graphite-worker" });
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

  let dataClient: DataClient | null = null;
  const getDataClient = (): DataClient => {
    dataClient ??= createDataClient(`${env.DATA_GRPC_HOST}:${env.DATA_GRPC_PORT}`);
    return dataClient;
  };

  // Internal-only MCP server: the agent orchestrator connects here as its sole
  // tool source. Identity arrives via signed internal headers.
  const mcpApp = express();
  mcpApp.disable("x-powered-by");
  mcpApp.use(express.json({ limit: "2mb" }));
  mcpApp.use(
    createMcpRouter({
      db,
      sql,
      redis,
      getDataClient,
      secret: env.INTERNAL_MCP_SECRET,
    }),
  );
  mcpApp.listen(env.WORKER_INTERNAL_MCP_PORT, "127.0.0.1", () => {
    log.info({ port: env.WORKER_INTERNAL_MCP_PORT }, "internal MCP server listening");
  });

  const workers = [
    startIngestionWorker({
      connection: redis,
      db,
      sql,
      storage,
      bucket: env.S3_BUCKET,
      concurrency: env.INGESTION_CONCURRENCY,
    }),
    startAgentRunWorker({
      connection: redis,
      db,
      sql,
      mcpBaseUrl: `http://127.0.0.1:${env.WORKER_INTERNAL_MCP_PORT}`,
      mcpSecret: env.INTERNAL_MCP_SECRET,
      tokenBudget: env.AGENT_TOKEN_BUDGET,
      concurrency: env.AGENT_RUN_CONCURRENCY,
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
  // Prometheus metrics incl. queue depth (Phase 8).
  const queueDepth = new client.Gauge({
    name: "graphite_queue_depth",
    help: "BullMQ queue depth (waiting jobs) by queue",
    labelNames: ["queue"] as const,
    registers: [registry],
  });
  let depthTimer: NodeJS.Timeout | undefined;
  health.get("/metrics", async (_req, res) => {
    try {
      for (const name of ["ingestion", "agent-run"]) {
        const counts = await new (await import("bullmq")).Queue(name, { connection: redis }).getJobCounts("waiting");
        queueDepth.labels(name).set(counts.waiting ?? 0);
      }
      res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      res.send(await renderMetrics());
    } catch {
      res.status(500).end();
    } finally {
      clearInterval(depthTimer);
    }
  });
  // Refresh queue depth periodically for scrape independence.
  depthTimer = setInterval(() => {
    void (async () => {
      try {
        for (const name of ["ingestion", "agent-run"]) {
          const counts = await new (await import("bullmq")).Queue(name, { connection: redis }).getJobCounts("waiting");
          queueDepth.labels(name).set(counts.waiting ?? 0);
        }
      } catch {
        // metrics best-effort
      }
    })();
  }, 10_000);
  depthTimer.unref();
  health.listen(env.WORKER_HEALTH_PORT, () => {
    log.info({ port: env.WORKER_HEALTH_PORT }, "worker health endpoint listening");
  });

  log.info({ queues: workers.map((w) => w.name) }, "worker booted");
}

main().catch((e) => {
  log.error({ err: e }, "fatal worker startup error");
  process.exit(1);
});
