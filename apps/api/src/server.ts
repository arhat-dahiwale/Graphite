import { childLogger } from "@graphite/core";
import { loadRootEnv } from "@graphite/core/config";
import { createDb } from "@graphite/db/client";
import { getMembership } from "@graphite/db/repo/members";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { env } from "./env.js";
import { createRedis } from "./redis.js";

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

  const { app } = createApp(
    {
      db,
      sql,
      redis,
      auth,
      resolveMembershipRole: async (user, orgId) => getMembership(db, orgId, user.id),
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
