import { childLogger } from "@graphite/core";
import { loadRootEnv } from "@graphite/core/config";
import { createDb } from "@graphite/db/client";
import { getMembership } from "@graphite/db/repo/members";
import { Queue } from "bullmq";
import { createStorage, ensureBucket } from "@graphite/storage";
import { createDataClient, type DataClient } from "@graphite/data/client";
import type { Server as HttpServer } from "node:http";
import { setupCollab } from "./collab.js";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { env } from "./env";
import { createRedis } from "./redis";

loadRootEnv();
const log = childLogger({ component: "api" });

async function main(): Promise<void> {
  const { sql, db } = createDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  await redis.connect();

  const auth = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
    webUrl: env.WEB_URL,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : undefined,
  });

  const storage = createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  await ensureBucket(storage, env.S3_BUCKET);

  const ingestionQueue = new Queue("ingestion", {
    connection: redis,
  });
  const agentRunQueue = new Queue("agent-run", { connection: redis });

  const dataClients = new Map<string, DataClient>();
  const getDataClient = (): DataClient => {
    const addr = `${env.DATA_GRPC_HOST}:${env.DATA_GRPC_PORT}`;
    let c = dataClients.get(addr);
    if (!c) {
      c = createDataClient(addr);
      dataClients.set(addr, c);
    }
    return c;
  };

  const { app } = createApp(
    {
      db,
      sql,
      redis,
      auth,
      getDataClient,
      enqueueAgentRun: async (runId) => {
        await agentRunQueue.add("run", { runId }, { jobId: `agent-run-${runId}`, removeOnComplete: 200, removeOnFail: 200 });
      },
      resolveMembershipRole: async (user, orgId) => getMembership(db, orgId, user.id),
    },
    {
      allowedOrigins: [env.WEB_URL, "http://localhost:3000", "http://127.0.0.1:3000"],
      rest: {
        storage,
        bucket: env.S3_BUCKET,
        ingestionQueue,
        maxUploadMb: env.MAX_UPLOAD_MB,
        dataGrpcAddress: `${env.DATA_GRPC_HOST}:${env.DATA_GRPC_PORT}`,
        maxQueryRows: env.MAX_QUERY_ROWS,
        statementTimeoutMs: env.STATEMENT_TIMEOUT_MS,
      },
    },
  );

  const server = app.listen(env.API_PORT, () => {
    log.info({ port: env.API_PORT }, "graphite api listening");
  });

  // Real-time collaboration (Socket.IO with the Redis adapter).
  const subRedis = createRedis(env.REDIS_URL);
  await subRedis.connect();
  setupCollab({
    httpServer: server as HttpServer,
    redis,
    redisSub: subRedis,
    db,
    auth,
    allowedOrigins: [env.WEB_URL, "http://localhost:3000", "http://127.0.0.1:3000"],
  });

  const shutdown = (): void => {
    log.info("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error({ err: e }, "fatal startup error");
  process.exit(1);
});
