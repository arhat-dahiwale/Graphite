import type { Database } from "@graphite/db/client";
import { createDb } from "@graphite/db/client";
import type Redis from "ioredis";
import RedisClient from "ioredis";
import type { Sql } from "postgres";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import type { AppDeps } from "../src/context.js";
import { getMembership } from "@graphite/db/repo/members";

/**
 * Shared integration-test harness: a real app instance against the
 * graphite_test database and a throwaway Redis DB, listening on an ephemeral
 * port. Tests exercise the full HTTP + cookie path.
 */

export const TEST_DB_NAME = "graphite_test";
export const TEST_REDIS_DB = 9; // isolated logical DB for tests

export interface TestApp {
  baseUrl: string;
  db: Database;
  sql: Sql;
  redis: Redis;
  authSecret: string;
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  loadEnv();
  const adminUrl = requireEnv("DATABASE_ADMIN_URL");
  const u = new URL(adminUrl);
  u.pathname = `/${TEST_DB_NAME}`;

  u.username = "graphite_app";
  u.password = "app_password";
  const appDbUrl = u.toString();

  const { sql, db } = createDb(appDbUrl, { max: 10 });
  const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6380", {
    maxRetriesPerRequest: null,
  });
  redis.select(TEST_REDIS_DB);

  // Clean state: truncate every table in the test database.
  await truncateAll(sql);

  const authSecret = "test-secret-not-for-production";
  const auth = createAuth({
    db,
    secret: authSecret,
    baseUrl: "http://127.0.0.1:4000",
    webUrl: "http://localhost:3000",
  });

  const deps: AppDeps = {
    db,
    sql,
    redis,
    auth,
    resolveMembershipRole: async (user, orgId) => getMembership(db, orgId, user.id),
  };

  const { app } = createApp(deps, {
    allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    db,
    sql,
    redis,
    authSecret,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

/** Call a REST endpoint with a session cookie. */
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
