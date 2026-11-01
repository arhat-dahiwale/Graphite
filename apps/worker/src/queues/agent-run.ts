import { Worker } from "bullmq";
import { childLogger } from "@graphite/core";
import {
  context as otelContext,
  SpanStatusCode,
} from "@opentelemetry/api";
import { extractTraceContext, injectTraceContext, startSpanFor } from "@graphite/telemetry";
import { jobDuration } from "@graphite/telemetry/metrics";
import type Redis from "ioredis";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import { executeRun } from "../agent/orchestrator.js";

const log = childLogger({ component: "worker-agent-run" });

export const AGENT_RUN_QUEUE = "agent-run";

/** Enqueue an agent run, propagating the caller's trace context in job data. */
export function makeAgentRunEnqueuer(connection: Redis): (runId: string) => Promise<void> {
  return async (runId) => {
    const { Queue } = await import("bullmq");
    const queue = new Queue(AGENT_RUN_QUEUE, { connection });
    const carrier = injectTraceContext({});
    await queue.add(
      "run",
      { runId, traceContext: carrier },
      { jobId: `agent-run-${runId}`, removeOnComplete: 200, removeOnFail: 200 },
    );
    await queue.close();
  };
}

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
      const started = Date.now();
      const runId = String(job.data.runId ?? "");
      if (!runId) throw new Error("agent-run job missing runId");
      log.info({ runId, jobId: job.id }, "processing agent run");
      // One trace per agent run: the API enqueues with its request trace
      // context; this span is the child that carries the whole run.
      const parentCtx = extractTraceContext(job.data.traceContext);
      const { span, ctx } = startSpanFor(parentCtx, "agent.run", { "graphite.run_id": runId });
      try {
        await otelContext.with(ctx, () =>
          executeRun(
            {
              db: opts.db,
              sql: opts.sql,
              redis: opts.connection,
              mcpBaseUrl: opts.mcpBaseUrl,
              mcpSecret: opts.mcpSecret,
              tokenBudget: opts.tokenBudget,
            },
            runId,
          ),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return { runId };
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : "failed" });
        throw e;
      } finally {
        span.end();
        jobDuration.observe({ queue: AGENT_RUN_QUEUE }, (Date.now() - started) / 1000);
      }
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
