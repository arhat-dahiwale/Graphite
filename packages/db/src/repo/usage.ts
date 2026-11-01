import { sql } from "drizzle-orm";
import { usageDaily } from "../schema";
import type { Database } from "../client";

/**
 * Per-org daily usage rollups (Phase 8 quotas). Upserted when agent runs
 * finish; `usage.orgSummary` reads from here.
 */
export async function recordRunUsage(
  db: Database,
  opts: { organizationId: string; inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  await db
    .insert(usageDaily)
    .values({
      organizationId: opts.organizationId,
      date,
      agentRuns: 1,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      costUsd: opts.costUsd.toFixed(6),
    })
    .onConflictDoUpdate({
      target: [usageDaily.organizationId, usageDaily.date],
      set: {
        agentRuns: sql`${usageDaily.agentRuns} + 1`,
        inputTokens: sql`${usageDaily.inputTokens} + ${opts.inputTokens}`,
        outputTokens: sql`${usageDaily.outputTokens} + ${opts.outputTokens}`,
        // cost_usd is a text column (DATA.md); accumulate numerically.
        costUsd: sql`(${usageDaily.costUsd}::numeric + ${opts.costUsd.toFixed(6)}::numeric)::text`,
      },
    });
}

export async function getUsageSummary(
  db: Database,
  organizationId: string,
  days = 14,
): Promise<Array<{ date: string; agentRuns: number; inputTokens: number; outputTokens: number; costUsd: string }>> {
  const rows = await db
    .select()
    .from(usageDaily)
    .where(sql`${usageDaily.organizationId} = ${organizationId}`)
    .orderBy(sql`${usageDaily.date} desc`)
    .limit(days);
  return rows.map((r) => ({
    date: r.date,
    agentRuns: r.agentRuns,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costUsd: r.costUsd,
  }));
}
