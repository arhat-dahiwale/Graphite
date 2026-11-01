import { Worker } from "bullmq";
import { childLogger } from "@graphite/core";
import type { S3Client } from "@aws-sdk/client-s3";
import type Redis from "ioredis";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import { processIngestion, type IngestionDeps } from "../ingestion/process.js";

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
      const datasetId = String(job.data.datasetId ?? "");
      if (!datasetId) throw new Error("ingestion job missing datasetId");
      log.info({ datasetId, jobId: job.id }, "processing ingestion job");
      const result = await processIngestion(deps, datasetId);
      if (result.status === "failed") {
        // The dataset row carries the error; fail the job without retry storm.
        throw new Error(`Ingestion failed for ${datasetId}`);
      }
      return result;
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
