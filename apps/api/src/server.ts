import { childLogger } from "@graphite/core";
import { loadRootEnv } from "@graphite/core/config";
import { createDb } from "@graphite/db/client";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { createRedis } from "./redis.js";

loadRootEnv();
const log = childLogger({ component: "api" });

async function main(): Promise<void> {
  const { sql, db } = createDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  await redis.connect();

  const noopResolveSession = async () => null;
  const noopMembership = async () => null;

  const { app } = createApp(
    {
      db,
      sql,
      redis,
      resolveSession: noopResolveSession,
      resolveMembershipRole: noopMembership,
    },
    { allowedOrigins: [env.WEB_URL, "http://localhost:3000", "http://127.0.0.1:3000"] },
  );

  const server = app.listen(env.API_PORT, () => {
    log.info({ port: env.API_PORT }, "graphite api listening");
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
