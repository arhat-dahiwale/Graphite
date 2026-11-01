import { Worker } from "bullmq";
import { childLogger } from "@graphite/core";
import { context as otelContext, SpanStatusCode } from "@opentelemetry/api";
import { extractTraceContext, startSpanFor } from "@graphite/telemetry";
import { jobDuration } from "@graphite/telemetry/metrics";
import type { S3Client } from "@aws-sdk/client-s3";
import type Redis from "ioredis";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import { processIngestion, type IngestionDeps } from "../ingestion/process";

const log = childLogger({ component: "worker-ingestion" });

export const INGESTION_QUEUE = "ingestion";

export function startIngestionWorker(opts: {
  connection: Redis;
  db: Database;
  sql: Sql;
  storage: S3Client;
  bucket: string;
  concurrency: number;
}): Worker {
  const deps: IngestionDeps = {
    db: opts.db,
    sql: opts.sql,
    storage: opts.storage,
    redis: opts.connection,
    bucket: opts.bucket,
  };

  const worker = new Worker(
    INGESTION_QUEUE,
    async (job) => {
      const started = Date.now();
      const datasetId = String(job.data.datasetId ?? "");
      if (!datasetId) throw new Error("ingestion job missing datasetId");
      log.info({ datasetId, jobId: job.id }, "processing ingestion job");
      const parentCtx = extractTraceContext(job.data.traceContext);
      const { span, ctx } = startSpanFor(parentCtx, "ingestion.job", {
        "graphite.dataset_id": datasetId,
      });
      try {
        const result = await otelContext.with(ctx, () => processIngestion(deps, datasetId));
        if (result.status === "failed") {
          // The dataset row carries the error; fail the job without retry storm.
          throw new Error(`Ingestion failed for ${datasetId}`);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : "failed" });
        throw e;
      } finally {
        span.end();
        jobDuration.observe({ queue: INGESTION_QUEUE }, (Date.now() - started) / 1000);
      }
    },
    {
      connection: opts.connection,
      concurrency: opts.concurrency,
      // Deterministic job IDs make retries idempotent; keep attempts low because
      // the processor itself is safe to re-run (it recreates the table).
      limiter: undefined,
    },
  );

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "ingestion job failed");
  });

  return worker;
}
