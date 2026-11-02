import { Worker } from "bullmq";
import { childLogger } from "@graphite/core";
import type Redis from "ioredis";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import { executeRun } from "../agent/orchestrator.js";

const log = childLogger({ component: "worker-agent-run" });

export const AGENT_RUN_QUEUE = "agent-run";

export function startAgentRunWorker(opts: {
  connection: Redis;
  db: Database;
  sql: Sql;
  mcpBaseUrl: string;
  mcpSecret: string;
  tokenBudget: number;
  concurrency: number;
}): Worker {
  const worker = new Worker(
    AGENT_RUN_QUEUE,
    async (job) => {
      const runId = String(job.data.runId ?? "");
      if (!runId) throw new Error("agent-run job missing runId");
      log.info({ runId, jobId: job.id }, "processing agent run");
      await executeRun(
        {
          db: opts.db,
          sql: opts.sql,
          redis: opts.connection,
          mcpBaseUrl: opts.mcpBaseUrl,
          mcpSecret: opts.mcpSecret,
          tokenBudget: opts.tokenBudget,
        },
        runId,
      );
      return { runId };
    },
    {
      connection: opts.connection,
      concurrency: opts.concurrency,
    },
  );
  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "agent-run job failed");
  });
  return worker;
}
