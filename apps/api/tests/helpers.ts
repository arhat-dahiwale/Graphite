import type { Database } from "@graphite/db/client";
import { createDb } from "@graphite/db/client";
import type Redis from "ioredis";
import RedisClient from "ioredis";
import type { Sql } from "postgres";
import { Queue } from "bullmq";
import { createStorage, ensureBucket } from "@graphite/storage";
import { createDataService } from "../../../services/data/src/service.js";
import { ServerCredentials } from "@grpc/grpc-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createMcpRouter } from "@graphite/mcp-server/server";
import { setupCollab } from "../src/collab.js";
import { startIngestionWorker } from "../../../apps/worker/src/queues/ingestion.js";
import { startAgentRunWorker } from "../../../apps/worker/src/queues/agent-run.js";
import { createDataClient, type DataClient } from "@graphite/data/client";
import type { Worker as BullWorker } from "bullmq";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import type { AppDeps } from "../src/context.js";
import { getMembership } from "@graphite/db/repo/members";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(dir, "..", "..", "..", "services", "data", "proto", "data.proto");

/**
 * Shared integration-test harness: a real app instance against the
 * graphite_test database, a throwaway Redis DB, real MinIO, an in-process
 * gRPC data service, and a live ingestion worker. Tests exercise the full
 * HTTP + cookie path.
 */

export const TEST_DB_NAME = "graphite_test";
export const TEST_REDIS_DB = 9; // isolated logical DB for tests
export const TEST_BUCKET = "graphite-test-uploads";

export interface TestApp {
  baseUrl: string;
  db: Database;
  sql: Sql;
  /** App-role pool on the test DB (same as `sql`). */
  redis: Redis;
  ingestionQueue: Queue;
  dataPort: number;
  authSecret: string;
  auth: ReturnType<typeof createAuth>;
  storage: ReturnType<typeof createStorage>;
  maxUploadMb: number;
  maxQueryRows: number;
  statementTimeoutMs: number;
  /** Internal MCP server (the agent's only tool source). */
  mcpPort: number;
  mcpSecret: string;
  close: () => Promise<void>;
}

export async function startTestApp(
  opts?: { agentTokenBudget?: number; redisDb?: number },
): Promise<TestApp> {
  loadEnv();
  const adminUrl = requireEnv("DATABASE_ADMIN_URL");
  const u = new URL(adminUrl);
  u.pathname = `/${TEST_DB_NAME}`;
  const testAdminUrl = u.toString();

  u.username = "graphite_app";
  u.password = "app_password";
  const appDbUrl = u.toString();

  const { sql, db } = createDb(appDbUrl, { max: 10 });
  const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });
  redis.select(opts?.redisDb ?? TEST_REDIS_DB);
  await redis.flushdb();

  // Clean state: truncate every table in the test database.
  await truncateAll(sql);

  const authSecret = "test-secret-not-for-production";
  const auth = createAuth({
    db,
    secret: authSecret,
    baseUrl: "http://127.0.0.1:4000",
    webUrl: "http://localhost:3000",
  });

  // Object storage (real MinIO).
  const storage = createStorage({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9002",
    region: "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    bucket: TEST_BUCKET,
    forcePathStyle: true,
  });
  await ensureBucket(storage, TEST_BUCKET);

  // Read-only pool for the data service (same user-visible SQL path as prod).
  const roUrl = new URL(testAdminUrl);
  roUrl.username = "graphite_readonly";
  roUrl.password = "readonly_password";
  const readonlyDb = createDb(roUrl.toString(), { max: 5 });

  // In-process gRPC data service on an ephemeral port.
  const { server: grpcServer } = createDataService({
    metadataSql: sql,
    readonlySql: readonlyDb.sql,
    protoPath: PROTO_PATH,
    maxQueryRows: 1000,
    statementTimeoutMs: 2000,
  });
  const dataPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else resolve(port);
    });
  });

  const ingestionQueue = new Queue("ingestion", { connection: redis });
  const agentRunQueue = new Queue("agent-run", { connection: redis });
  const worker: BullWorker = startIngestionWorker({
    connection: redis,
    db,
    sql,
    storage,
    bucket: TEST_BUCKET,
    concurrency: 2,
  });
  // The test harness mounts the SAME internal MCP server the worker uses in
  // production, so agent tool calls flow through MCP here as well.
  const mcpSecret = "test-internal-mcp-secret";
  const mcpApp = express();
  mcpApp.use(express.json({ limit: "2mb" }));
  mcpApp.use(
    createMcpRouter({
      db,
      sql,
      redis,
      getDataClient: () => {
        dataClientLazy ??= createDataClient(`127.0.0.1:${dataPort}`);
        return dataClientLazy;
      },
      secret: mcpSecret,
    }),
  );
  const mcpServer = mcpApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => mcpServer.once("listening", resolve));
  const mcpAddr = mcpServer.address();
  if (!mcpAddr || typeof mcpAddr === "string") throw new Error("no mcp port");
  const agentWorker: BullWorker = startAgentRunWorker({
    connection: redis,
    db,
    sql,
    mcpBaseUrl: `http://127.0.0.1:${mcpAddr.port}`,
    mcpSecret,
    tokenBudget: opts?.agentTokenBudget ?? Number(process.env.AGENT_TOKEN_BUDGET ?? 200_000),
    concurrency: 2,
  });

  let dataClientLazy: DataClient | null = null;
  const deps: AppDeps = {
    db,
    sql,
    redis,
    auth,
    getDataClient: () => {
      dataClientLazy ??= createDataClient(`127.0.0.1:${dataPort}`);
      return dataClientLazy;
    },
    enqueueAgentRun: async (runId) => {
      await agentRunQueue.add(
        "run",
        { runId },
        { jobId: `agent-run-${runId}`, removeOnComplete: 200, removeOnFail: 200 },
      );
    },
    resolveMembershipRole: async (user, orgId) => getMembership(db, orgId, user.id),
  };

  const { app } = createApp(deps, {
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
    rest: {
      storage,
      bucket: TEST_BUCKET,
      ingestionQueue,
      maxUploadMb: 50,
      dataGrpcAddress: `127.0.0.1:${dataPort}`,
      maxQueryRows: 1000,
      statementTimeoutMs: 2000,
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const collabSub = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });
  collabSub.select(TEST_REDIS_DB);
  setupCollab({
    httpServer: server,
    redis,
    redisSub: collabSub,
    db,
    auth,
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  });

  return {
    baseUrl,
    db,
    sql,
    redis,
    ingestionQueue,
    dataPort,
    authSecret,
    auth,
    storage,
    maxUploadMb: 50,
    maxQueryRows: 1000,
    statementTimeoutMs: 2000,
    mcpPort: mcpAddr.port,
    mcpSecret,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      collabSub.disconnect();
      await worker.close();
      await agentWorker.close();
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
      await ingestionQueue.close();
      await agentRunQueue.close();
      grpcServer.tryShutdown(() => undefined);
      readonlyDb.sql.end();
      redis.disconnect();
      await sql.end();
    },
  };
}

export function loadEnv(): void {
  // Walk up to the repo root .env (tests run with apps/api cwd).
  // core's loadRootEnv checks existsSync before parsing (dotenv 17 returns an
  // empty parsed object for missing files).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadRootEnv } = require("@graphite/core/config") as { loadRootEnv: () => void };
  loadRootEnv();
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} for integration tests`);
  return v;
}

/** Truncate every table in the test database (public schema). */
export async function truncateAll(sql: Sql): Promise<void> {
  const tables = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%'
  `;
  const names = tables.map((r) => `"${r.tablename}"`).join(", ");
  if (names.length > 0) {
    await sql.unsafe(`TRUNCATE TABLE ${names} CASCADE`);
  }
  // Drop any leftover dataset tables from previous runs.
  const dsTables = await sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'datasets'
  `;
  for (const t of dsTables) {
    await sql.unsafe(`DROP TABLE IF EXISTS datasets."${t.tablename}" CASCADE`);
  }
}

/** Sign up via the real Better Auth HTTP flow; returns the session cookie. */
export async function signUp(
  baseUrl: string,
  email: string,
  name = "Test User",
  password = "password12345",
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  }
  return getCookie(res);
}

export async function signIn(
  baseUrl: string,
  email: string,
  password = "password12345",
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
  }
  return getCookie(res);
}

function getCookie(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.includes("better-auth.session_token"));
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(setCookie)}`);
  return session.split(";")[0] as string;
}

/** Call a tRPC procedure with a session cookie. */
export async function trpc<T>(
  baseUrl: string,
  cookie: string,
  path: string,
  input?: unknown,
  method: "query" | "mutation" = "query",
): Promise<T> {
  const isQuery = method === "query";
  const url = new URL(`${baseUrl}/trpc/${path}`);
  if (isQuery && input !== undefined) {
    url.searchParams.set("input", JSON.stringify(input));
  }
  const res = await fetch(url, {
    method: isQuery ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: isQuery ? undefined : JSON.stringify({ ...(input as object) }),
  });
  const body = (await res.json()) as
    | { result: { data: T } }
    | { error: { message: string; data?: { code?: string } } };
  if ("error" in body) {
    const code = body.error.data?.code ?? "UNKNOWN";
    const err = new Error(`tRPC ${path} failed: ${code} ${body.error.message}`);
    (err as Error & { code?: string }).code = code;
    throw err;
  }
  return body.result.data;
}

/** Call a REST endpoint with a session cookie (JSON body). */
export async function rest(
  baseUrl: string,
  cookie: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Upload a CSV via the real multipart endpoint. */
export async function uploadCsv(
  baseUrl: string,
  cookie: string,
  projectId: string,
  filename: string,
  csv: string,
): Promise<{ status: number; json: { dataset?: { id: string; status: string }; jobId?: string } }> {
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), filename);
  const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/datasets`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { dataset?: { id: string; status: string }; jobId?: string };
  return { status: res.status, json };
}

/**
 * Collect SSE events from an endpoint until one of `until` event names fires
 * (or timeout). Returns the parsed events with their names.
 */
export async function collectSse(
  baseUrl: string,
  cookie: string,
  path: string,
  until: string[],
  timeoutMs = 30_000,
): Promise<Array<{ event: string; data: unknown }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: Array<{ event: string; data: unknown }> = [];
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";
    const done = new Promise<void>((resolve) => {
      void (async () => {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let eventName = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (eventName === "ping") continue;
            let parsed: unknown = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // keep raw
            }
            events.push({ event: eventName, data: parsed });
            currentEvent = eventName;
          }
          if (until.includes(currentEvent)) break;
        }
        resolve();
      })();
    });
    await done;
  } catch {
    // aborted on timeout — return what we collected
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

/** Poll a JSON REST endpoint until a predicate passes. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}


/**
 * Start an additional API instance (own HTTP port, own Socket.IO server with
 * its own Redis adapter connections) sharing the SAME database and Redis —
 * the multi-instance deployment shape.
 */
let dataClientLazy: DataClient | null = null;

export async function startSecondInstance(app: TestApp): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createApp } = await import("../src/app.js");
  const { setupCollab } = await import("../src/collab.js");
  const subRedis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });
  subRedis.select(TEST_REDIS_DB);

  const deps: AppDeps = {
    db: app.db,
    sql: app.sql,
    redis: app.redis,
    auth: app.auth,
    getDataClient: () => {
      dataClientLazy ??= createDataClient(`127.0.0.1:${app.dataPort}`);
      return dataClientLazy;
    },
    enqueueAgentRun: async (runId) => {
      await app.redis.select(0).catch(() => undefined);
      // Enqueue through the same Redis the first instance's queue uses.
      const { Queue } = await import("bullmq");
      const q = new Queue("agent-run", { connection: app.redis });
      await q.add("run", { runId }, { jobId: `agent-run-${runId}`, removeOnComplete: 200, removeOnFail: 200 });
      await q.close();
    },
    resolveMembershipRole: async (user, orgId) => getMembership(app.db, orgId, user.id),
  };
  const { app: expressApp } = createApp(deps, {
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  });
  const server = expressApp.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  setupCollab({
    httpServer: server,
    redis: app.redis,
    redisSub: subRedis,
    db: app.db,
    auth: app.auth,
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  });

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      subRedis.disconnect();
    },
  };
}
