import { and, eq, inArray, lt, isNull } from "drizzle-orm";
import z from "zod";
import { childLogger } from "@graphite/core";
import { loadRootEnv, parseEnv } from "@graphite/core/config";
import { createDb } from "@graphite/db/client";
import { agentRuns, invitations, mcpTokens, sessions } from "@graphite/db/schema";

/**
 * Maintenance job (run by the k8s CronJob or manually): clean up expired
 * invitations, dead tokens, stale queued runs, and old sessions. Idempotent
 * by construction (all statements are deletes/updates bounded by status).
 */

loadRootEnv();
const log = childLogger({ component: "maintenance" });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
});

async function main(): Promise<void> {
  const env = parseEnv(envSchema);
  const { db, sql } = createDb(env.DATABASE_URL);

  // 1. Expired invitations -> expired status.
  const inv = await db
    .update(invitations)
    .set({ status: "expired" })
    .where(and(eq(invitations.status, "pending"), lt(invitations.expiresAt, new Date())))
    .returning({ id: invitations.id });
  log.info({ count: inv.length }, "expired invitations marked");

  // 2. Agent runs stuck queued/running for over an hour -> failed.
  const stale = await db
    .update(agentRuns)
    .set({ status: "failed", error: "stale run reclaimed by maintenance", finishedAt: new Date() })
    .where(
      and(
        inArray(agentRuns.status, ["queued", "running"]),
        lt(agentRuns.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    )
    .returning({ id: agentRuns.id });
  log.info({ count: stale.length }, "stale agent runs reclaimed");

  // 3. Expired personal access tokens (past expiry) -> revoked.
  const tokens = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(isNull(mcpTokens.revokedAt), lt(mcpTokens.expiresAt, new Date())))
    .returning({ id: mcpTokens.id });
  log.info({ count: tokens.length }, "expired MCP tokens revoked");

  // 4. Sessions older than 30 days.
  const oldSessions = await db
    .delete(sessions)
    .where(lt(sessions.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))
    .returning({ id: sessions.id });
  log.info({ count: oldSessions.length }, "old sessions deleted");

  await sql.end();
  log.info("maintenance complete");
}

main().catch((e) => {
  log.error({ err: e }, "maintenance failed");
  process.exit(1);
});
