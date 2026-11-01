import { AppError, notFound, unprocessable, type AppError as AppErrorT } from "@graphite/core";
import { withSpan } from "@graphite/telemetry";
import type { Sql, TransactionSql } from "postgres";
import { checkSql } from "./sqlcheck";

export interface DataServiceOptions {
  /** App-role pool for dataset metadata (id -> table resolution). */
  metadataSql: Sql;
  /** Read-only pool for all user-visible SQL. */
  readonlySql: Sql;
  protoPath: string;
  maxQueryRows: number;
  statementTimeoutMs: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  statsJson: string;
}

interface ResolvedDataset {
  id: string;
  tableName: string;
  organizationId: string;
  rowCount: number | null;
  columns: ColumnMeta[];
}

export interface GrpcCallContext {
  organizationId?: string;
  userId?: string;
  requestId?: string;
}

function requireCtx(ctx: GrpcCallContext | undefined): GrpcCallContext {
  if (!ctx || typeof ctx.organizationId !== "string" || ctx.organizationId.length === 0) {
    throw new AppError("FORBIDDEN", "Missing organization context");
  }
  return ctx;
}

/**
 * User-visible SQL execution. Metadata (dataset id -> table) resolves through
 * the app-role pool; every statement runs on the read-only pool with a
 * per-transaction statement timeout and a hard row cap.
 */
export function buildServiceImplementation(options: DataServiceOptions) {
  const { metadataSql, readonlySql, maxQueryRows, statementTimeoutMs } = options;

  async function resolveDataset(
    ctx: GrpcCallContext,
    datasetId: string,
  ): Promise<ResolvedDataset> {
    const rows = await metadataSql`
      SELECT id, table_name, organization_id, row_count, status, deleted_at
      FROM public.datasets
      WHERE id = ${datasetId}
    `;
    const d = rows[0] as
      | {
          id: string;
          table_name: string | null;
          organization_id: string;
          row_count: number | null;
          status: string;
          deleted_at: Date | null;
        }
      | undefined;
    if (!d || d.deleted_at) throw notFound("Dataset not found");
    if (d.organization_id !== ctx.organizationId) {
      // Do not reveal existence across tenants.
      throw notFound("Dataset not found");
    }
    if (d.status !== "ready" || !d.table_name) {
      throw unprocessable("Dataset is not ready for querying");
    }
    const cols = await metadataSql`
      SELECT name, COALESCE(user_type, inferred_type) AS type, nullable, stats
      FROM public.dataset_columns
      WHERE dataset_id = ${datasetId}
      ORDER BY position
    `;
    const columns: ColumnMeta[] = cols.map((c: Record<string, unknown>) => {
      return {
        name: String(c.name),
        type: String(c.type),
        nullable: Boolean(c.nullable),
        statsJson: JSON.stringify(c.stats ?? {}),
      };
    });
    return {
      id: d.id,
      tableName: d.table_name,
      organizationId: d.organization_id,
      rowCount: d.row_count,
      columns,
    };
  }

  function quoteTable(tableName: string): string {
    if (!/^[a-z0-9_]+$/.test(tableName)) throw unprocessable("Invalid dataset table name");
    return `datasets."${tableName}"`;
  }

  async function runReadonlySelect(
    sqlText: string,
    rowLimit: number,
    timeoutMs: number,
  ): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean; durationMs: number }> {
    const cappedRows = Math.max(1, Math.min(Math.floor(rowLimit) || maxQueryRows, maxQueryRows));
    const cappedTimeout = Math.max(1, Math.min(Math.floor(timeoutMs) || statementTimeoutMs, statementTimeoutMs));
    const started = Date.now();
    return withSpan("sql.query", { "db.statement": sqlText.slice(0, 500), "graphite.row_limit": cappedRows }, async () => {
    try {
      return await readonlySql.begin(async (tx: TransactionSql<Record<string, unknown>>) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${cappedTimeout}`);
        // Outer wrapper caps result rows regardless of inner LIMIT.
        const wrapped = `SELECT * FROM (${sqlText}) AS _graphite_q LIMIT ${cappedRows + 1}`;
        const result = await tx.unsafe(wrapped);
        const fields = (result as unknown as { fields?: Array<{ name: string }> }).fields ?? [];
        const rows = result as unknown[];
        const truncated = rows.length > cappedRows;
        const limited = truncated ? rows.slice(0, cappedRows) : rows;
        const columnNames =
          fields.length > 0
            ? fields.map((f) => f.name)
            : limited.length > 0
              ? Object.keys(limited[0] as object)
              : [];
        return {
          columns: columnNames,
          rows: limited.map((r) => Object.values(r as object)),
          truncated,
          durationMs: Date.now() - started,
        };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "query failed";
      if (/statement timeout|timeout/i.test(msg)) {
        throw new AppError("UNPROCESSABLE", `Query exceeded the ${cappedTimeout}ms timeout`, {
          cause: e,
        });
      }
      throw new AppError("BAD_REQUEST", msg.slice(0, 300), { cause: e });
    }
    });
  }

  function toRowsResponse(r: {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    durationMs: number;
  }): {
    columns: string[];
    rows: Array<{ valuesJson: string[] }>;
    truncated: boolean;
    durationMs: number;
  } {
    return {
      columns: r.columns,
      rows: r.rows.map((row) => ({ valuesJson: row.map((v) => JSON.stringify(v ?? null)) })),
      truncated: r.truncated,
      durationMs: r.durationMs,
    };
  }

  return {
    async describeDataset(call: { request: { ctx?: GrpcCallContext; datasetId?: string } }) {
      const ctx = requireCtx(call.request.ctx);
      const ds = await resolveDataset(ctx, String(call.request.datasetId ?? ""));
      return {
        datasetId: ds.id,
        rowCount: ds.rowCount ?? 0,
        columns: ds.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          statsJson: c.statsJson,
        })),
      };
    },

    async sampleRows(call: { request: { ctx?: GrpcCallContext; datasetId?: string; limit?: number } }) {
      const ctx = requireCtx(call.request.ctx);
      const ds = await resolveDataset(ctx, String(call.request.datasetId ?? ""));
      const limit = Math.max(1, Math.min(Number(call.request.limit ?? 10) || 10, 100));
      const result = await runReadonlySelect(
        `SELECT * FROM ${quoteTable(ds.tableName)} ORDER BY _row_id LIMIT ${limit}`,
        limit,
        statementTimeoutMs,
      );
      return toRowsResponse(result);
    },

    async columnStats(call: {
      request: { ctx?: GrpcCallContext; datasetId?: string; column?: string };
    }) {
      const ctx = requireCtx(call.request.ctx);
      const ds = await resolveDataset(ctx, String(call.request.datasetId ?? ""));
      const colName = String(call.request.column ?? "");
      const col = ds.columns.find((c) => c.name === colName);
      if (!col) throw notFound("Column not found");
      // Stats were computed at ingestion time; serve them without touching data.
      return { statsJson: col.statsJson };
    },

    async runQuery(call: {
      request: {
        ctx?: GrpcCallContext;
        datasetIds?: string[];
        sql?: string;
        rowLimit?: number;
        timeoutMs?: number;
      };
    }) {
      const ctx = requireCtx(call.request.ctx);
      const datasetIds = (call.request.datasetIds ?? []).map(String);
      if (datasetIds.length === 0) {
        throw unprocessable("dataset_ids (table allowlist) is required");
      }
      const resolved: ResolvedDataset[] = [];
      for (const id of datasetIds) {
        resolved.push(await resolveDataset(ctx, id));
      }
      const allowedTables = resolved.map((d) => `datasets.${d.tableName}`);
      const sqlText = String(call.request.sql ?? "");
      const check: { ok: boolean; error?: AppErrorT; tables: string[] } = checkSql({
        sql: sqlText,
        allowedTables,
      });
      if (!check.ok) throw check.error ?? unprocessable("Unsafe SQL rejected");
      const result = await runReadonlySelect(
        sqlText,
        Number(call.request.rowLimit ?? maxQueryRows) || maxQueryRows,
        Number(call.request.timeoutMs ?? statementTimeoutMs) || statementTimeoutMs,
      );
      return toRowsResponse(result);
    },
  };
}
