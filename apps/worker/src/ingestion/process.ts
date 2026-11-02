import Papa from "papaparse";
import {
  childLogger,
  dedupeColumnNames,
  datasetEventsChannel,
  sanitizeColumnName,
  type DatasetEvent,
} from "@graphite/core";
import type { Database } from "@graphite/db/client";
import { and, eq } from "drizzle-orm";
import { datasets, datasetColumns, type ColumnType, type DatasetColumn } from "@graphite/db/schema";
import { castCell, inferColumnType, isNullableSample, pgTypeFor, type ColumnSpec } from "./types";
import type { S3Client } from "@aws-sdk/client-s3";
import { getObjectStream } from "@graphite/storage";
import type Redis from "ioredis";
import type { Sql as PostgresSql } from "postgres";

const log = childLogger({ component: "ingestion" });

export interface IngestionDeps {
  db: Database;
  sql: PostgresSql;
  storage: S3Client;
  redis: Redis;
  bucket: string;
}

const SAMPLE_ROWS = 1000;
const BATCH_ROWS = 1000;
const MAX_PARAMS = 30_000; // stay well under the 65535 wire limit
const PROGRESS_EVERY_ROWS = 25_000;

async function publish(deps: IngestionDeps, event: DatasetEvent): Promise<void> {
  await deps.redis.publish(datasetEventsChannel(event.datasetId), JSON.stringify(event));
}

/**
 * Ingest a dataset: stream the CSV from object storage, infer column types
 * from a sample, load every row into `datasets.<datasetId>`, compute column
 * stats, and mark the dataset ready. Idempotent: re-running drops and
 * recreates the table, so a retried job never duplicates rows.
 */
export async function processIngestion(
  deps: IngestionDeps,
  datasetId: string,
): Promise<{ status: "ready" | "failed"; rowCount: number }> {
  const rows = await deps.db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1);
  const dataset = rows[0];
  if (!dataset) throw new Error(`Dataset ${datasetId} not found`);
  if (dataset.deletedAt) throw new Error(`Dataset ${datasetId} is deleted`);

  await deps.db
    .update(datasets)
    .set({ status: "processing", error: null, updatedAt: new Date() })
    .where(eq(datasets.id, datasetId));

  try {
    const result = await ingest(deps, datasetId, dataset.storageKey, dataset.sizeBytes);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ingestion failed";
    log.error({ err: e, datasetId }, "ingestion failed");
    await deps.db
      .update(datasets)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(datasets.id, datasetId));
    await publish(deps, {
      type: "error",
      datasetId,
      data: { status: "failed", message: message.slice(0, 500) },
    });
    return { status: "failed", rowCount: 0 };
  }
}

async function ingest(
  deps: IngestionDeps,
  datasetId: string,
  storageKey: string,
  totalBytes: number,
): Promise<{ status: "ready" | "failed"; rowCount: number }> {
  const stream = await getObjectStream(deps.storage, deps.bucket, storageKey);
  const t0 = Date.now();

  let headers: string[] = [];
  const samples: string[][] = [];
  let specs: ColumnSpec[] = [];
  let columnsReady = false;
  let rowCount = 0;
  let bytesSeen = 0;
  let lastProgressRows = 0;
  let pending: string[][] = [];

  await publish(deps, {
    type: "progress",
    datasetId,
    data: { stage: "loading", rowsProcessed: 0, percent: 0 },
  });

  async function ensureColumns(): Promise<void> {
    if (columnsReady) return;
    if (headers.length === 0) throw new Error("CSV is empty or has no header row");
    const base = headers.map((h, i) => sanitizeColumnName(h || `col_${i}`, i));
    const names = dedupeColumnNames(base);
    specs = headers.map((h, i) => {
      const sampleValues = samples.slice(0, SAMPLE_ROWS).map((r) => r[i] ?? "");
      return {
        originalName: h,
        name: names[i] as string,
        type: inferColumnType(sampleValues),
        nullable: isNullableSample(sampleValues),
      };
    });
    await deps.db.delete(datasetColumns).where(eq(datasetColumns.datasetId, datasetId));
    await deps.db.insert(datasetColumns).values(
      specs.map((s, i) => ({
        datasetId,
        position: i,
        name: s.name,
        originalName: s.originalName,
        inferredType: s.type as ColumnType,
        nullable: s.nullable,
      })),
    );
    await createTable(deps, datasetId, specs);
    columnsReady = true;
    // The sampled rows are real data rows too; insert them as the first batch
    // (they are not part of `pending`).
    await flushBatch(samples.slice());
  }

  let inFlight: Array<Promise<unknown>> = [];

  async function flushBatch(batch: string[][]): Promise<void> {
    if (!columnsReady || batch.length === 0) return;
    const perRowParams = specs.length;
    const maxBatch = Math.max(1, Math.floor(MAX_PARAMS / Math.max(perRowParams, 1)));
    for (let i = 0; i < batch.length; i += maxBatch) {
      const slice = batch.slice(i, i + maxBatch);
      const cols = specs.map((s) => `"${s.name}"`).join(", ");
      // Unique parameter index per cell; explicit casts let Postgres type NULL
      // parameters (42P18 otherwise).
      let paramIndex = 0;
      const params: Array<string | number | boolean | Date | null> = [];
      const tuples = slice
        .map((row) =>
          `(${specs
            .map((s, j) => {
              paramIndex += 1;
              params.push(castCell(row[j] ?? "", s.type));
              return `$${paramIndex}::${pgTypeFor(s.type)}`;
            })
            .join(", ")})`,
        )
        .join(", ");
      // Identifiers are sanitized/generated; all values are parameterized.
      // postgres-js pipelines queries in order; collect and drain later.
      inFlight.push(
        deps.sql.unsafe(
          `INSERT INTO datasets."${datasetId}" (${cols}) VALUES ${tuples}`,
          params,
        ),
      );
    }
  }

  async function drain(): Promise<void> {
    const waiting = inFlight;
    inFlight = [];
    await Promise.all(waiting);
  }

  await new Promise<void>((resolve, reject) => {
    Papa.parse<string[]>(stream as unknown as NodeJS.ReadableStream, {
      header: false,
      skipEmptyLines: "greedy",
      chunkSize: 1024 * 1024,
      chunk: (results, parser) => {
        void (async () => {
          parser.pause();
          try {
            for (const raw of results.data) {
              if (headers.length === 0) {
                headers = (raw as string[]).map((h) => (h ?? "").trim());
                continue;
              }
              const row = raw as string[];
              rowCount += 1;
              bytesSeen += row.length;
              if (samples.length < SAMPLE_ROWS) samples.push(row);
              if (columnsReady || samples.length >= SAMPLE_ROWS) {
                pending.push(row);
                if (pending.length >= BATCH_ROWS) {
                  await ensureColumns();
                  const batch = pending;
                  pending = [];
                  await flushBatch(batch);
                  if (inFlight.length >= 8) await drain();
                }
              }
              if (rowCount - lastProgressRows >= PROGRESS_EVERY_ROWS) {
                lastProgressRows = rowCount;
                const percent =
                  totalBytes > 0 ? Math.min(99, Math.round((bytesSeen / totalBytes) * 100)) : 0;
                await publish(deps, {
                  type: "progress",
                  datasetId,
                  data: { stage: "loading", rowsProcessed: rowCount, percent },
                });
              }
            }
            parser.resume();
          } catch (e) {
            parser.abort();
            reject(e);
          }
        })();
      },
      complete: () => resolve(),
      error: (err: Error) => reject(err),
    });
  });

  await ensureColumns();
  await flushBatch(pending);
  await drain();
  log.info({ datasetId, rowsLoadedMs: Date.now() - t0, rowCount }, "rows loaded");

  // Finalize: stats, exact row count, grants, ready.
  const tStats = Date.now();
  await computeColumnStats(deps, datasetId, specs);
  log.info({ datasetId, statsMs: Date.now() - tStats }, "stats computed");
  const countRows = await deps.sql.unsafe(
    `SELECT COUNT(*)::int AS n FROM datasets."${datasetId}"`,
  );
  const finalRowCount = Number(((countRows[0] ?? {}) as unknown as { n: number }).n);

    await deps.sql.unsafe(`GRANT SELECT ON datasets."${datasetId}" TO graphite_readonly`);

  const schemaSummary = {
    columns: specs.map((s) => ({ name: s.name, type: s.type, originalName: s.originalName })),
    rowCount: finalRowCount,
  };

  await deps.db
    .update(datasets)
    .set({
      status: "ready",
      tableName: datasetId,
      rowCount: finalRowCount,
      schemaSummary,
      updatedAt: new Date(),
    })
    .where(eq(datasets.id, datasetId));

  await publish(deps, {
    type: "done",
    datasetId,
    data: { status: "ready", rowCount: finalRowCount },
  });
  log.info({ datasetId, rows: finalRowCount }, "ingestion complete");
  return { status: "ready", rowCount: finalRowCount };
}

async function createTable(
  deps: IngestionDeps,
  datasetId: string,
  specs: ColumnSpec[],
): Promise<void> {
  const cols = specs.map((s) => `"${s.name}" ${pgTypeFor(s.type)}`).join(",\n  ");
  // Table name is the dataset id (validated ID characters); columns are
  // sanitized identifiers. No user input reaches this statement unquoted.
  await deps.sql.unsafe(`DROP TABLE IF EXISTS datasets."${datasetId}"`);
  await deps.sql.unsafe(
    `CREATE TABLE datasets."${datasetId}" (\n  _row_id bigserial PRIMARY KEY,\n  ${cols}\n)`,
  );
}

export interface ColumnStats {
  count: number;
  nullCount: number;
  distinct: number;
  min?: string | number;
  max?: string | number;
  top?: Array<{ value: string; count: number }>;
}

async function computeColumnStats(
  deps: IngestionDeps,
  datasetId: string,
  specs: ColumnSpec[],
): Promise<void> {
  for (const spec of specs) {
    const col = `"${spec.name}"`;
    const table = `datasets."${datasetId}"`;
    const base = await deps.sql.unsafe(
      `SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE ${col} IS NULL)::int AS null_count, COUNT(DISTINCT ${col})::int AS distinct_count FROM ${table}`,
    );
    const b = (base[0] ?? {}) as unknown as { count: number; null_count: number; distinct_count: number };
    const stats: ColumnStats = {
      count: b.count,
      nullCount: b.null_count,
      distinct: b.distinct_count,
    };
    if (spec.type === "integer" || spec.type === "number") {
      const mm = await deps.sql.unsafe(`SELECT MIN(${col})::text AS min, MAX(${col})::text AS max FROM ${table}`);
      const m = (mm[0] ?? {}) as unknown as { min: string | null; max: string | null };
      stats.min = m.min !== null ? Number(m.min) : undefined;
      stats.max = m.max !== null ? Number(m.max) : undefined;
    } else if (spec.type === "date" || spec.type === "datetime") {
      const mm = await deps.sql.unsafe(`SELECT MIN(${col})::text AS min, MAX(${col})::text AS max FROM ${table}`);
      const m = (mm[0] ?? {}) as unknown as { min: string | null; max: string | null };
      stats.min = m.min ?? undefined;
      stats.max = m.max ?? undefined;
    } else if (spec.type === "text" || spec.type === "boolean") {
      const top = await deps.sql.unsafe(
        `SELECT ${col}::text AS v, COUNT(*)::int AS c FROM ${table} WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      );
      stats.top = top.map((r) => ({
        value: String(((r as unknown as { v: string }).v)),
        count: ((r as unknown as { c: number }).c),
      }));
    }
    await deps.db
      .update(datasetColumns)
      .set({ stats })
      .where(and(eq(datasetColumns.datasetId, datasetId), eq(datasetColumns.name, spec.name)));
  }
}

/** Recompute stats for one column after a type override. */
export async function recomputeColumnStat(
  deps: IngestionDeps,
  datasetId: string,
  column: DatasetColumn,
): Promise<void> {
  await computeColumnStats(deps, datasetId, [
    {
      name: column.name,
      originalName: column.originalName,
      type: column.inferredType,
      nullable: column.nullable,
    },
  ]);
}
