import { afterAll, describe, expect, it } from "vitest";
import type Redis from "ioredis";
import type { Sql } from "postgres";
import { createApp } from "../src/app.js";
import type { AppDeps } from "../src/context.js";

const stubSql = ((_strings: TemplateStringsArray) => {
  const q = Promise.resolve({ rows: [], count: 0, command: "" }) as Promise<unknown> & {
    timeout: (ms: number) => Promise<unknown>;
  };
  q.timeout = () => q;
  return q;
}) as unknown as Sql;

const stubRedis = {
  async ping() {
    return "PONG";
  },
} as unknown as Redis;

function makeDeps(): AppDeps {
  return {
    db: {} as AppDeps["db"],
    sql: stubSql,
    redis: stubRedis,
    resolveSession: async () => null,
    resolveMembershipRole: async () => null,
  };
}

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { app } = createApp(makeDeps());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterAll(() => {
  // no persistent handles in this suite
});

describe("phase 0 api smoke", () => {
  it("GET /healthz says ok", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", service: "api" });
    });
  });

  it("GET /readyz reports postgres and redis checks", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/readyz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checks: Record<string, string> };
      expect(body.checks).toEqual({ postgres: "ok", redis: "ok" });
    });
  });

  it("tRPC hello procedure responds", async () => {
    await withServer(async (base) => {
      const res = await fetch(
        `${base}/trpc/hello.hello?input=${encodeURIComponent(JSON.stringify({ name: "graphite" }))}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { data: { message: string } } };
      expect(body.result.data.message).toContain("graphite");
    });
  });

  it("unknown REST route returns the API.md error format", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/nope`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.requestId).toMatch(/^req_/);
    });
  });
});
