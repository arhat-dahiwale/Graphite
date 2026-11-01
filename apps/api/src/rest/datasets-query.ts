import { Router } from "express";
import { notFound } from "@graphite/core";
import { datasets, datasetColumns } from "@graphite/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { createDataClient, type DataClient, type GrpcContext } from "@graphite/data/client";
import type { Database } from "@graphite/db/client";
import type { GraphiteAuth } from "../auth.js";
import { resolveRestUser, requireRestAuthorized } from "./auth.js";

export interface DatasetRestDeps {
  db: Database;
  auth?: GraphiteAuth;
  dataGrpcAddress: string;
  maxQueryRows: number;
  statementTimeoutMs: number;
}

/**
 * Dataset metadata and preview. Preview rows always flow through the gRPC
 * data service so the read-only role, AST check, and row caps apply.
 */
export function datasetRestRouter(deps: DatasetRestDeps): Router {
  const r = Router();
  let client: DataClient | null = null;
  const dataClient = (): DataClient => {
    client ??= createDataClient(deps.dataGrpcAddress);
    return client;
  };
  const grpcCtx = (
    user: { id: string },
    orgId: string,
    requestId: string,
  ): GrpcContext => ({ organizationId: orgId, userId: user.id, requestId });

  r.get("/datasets/:datasetId", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} } });
        return;
      }
      const dsId = String(req.params.datasetId ?? "");
      const rows = await deps.db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1);
      const ds = rows[0];
      if (!ds || ds.deletedAt) throw notFound("Dataset not found");
      await requireRestAuthorized(deps.db, user, ds.organizationId, "dataset:read", { type: "dataset" });
      const cols = await deps.db
        .select()
        .from(datasetColumns)
        .where(eq(datasetColumns.datasetId, dsId))
        .orderBy(asc(datasetColumns.position));
      res.json({
        dataset: {
          id: ds.id,
          name: ds.name,
          originalFilename: ds.originalFilename,
          status: ds.status,
          error: ds.error,
          rowCount: ds.rowCount,
          sizeBytes: ds.sizeBytes,
          projectId: ds.projectId,
          organizationId: ds.organizationId,
          createdAt: ds.createdAt,
        },
        columns: cols.map((c) => ({
          name: c.name,
          originalName: c.originalName,
          position: c.position,
          inferredType: c.inferredType,
          userType: c.userType,
          nullable: c.nullable,
          stats: c.stats,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  r.get("/datasets/:datasetId/preview", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} } });
        return;
      }
      const dsId = String(req.params.datasetId ?? "");
      const rows = await deps.db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1);
      const ds = rows[0];
      if (!ds || ds.deletedAt) throw notFound("Dataset not found");
      await requireRestAuthorized(deps.db, user, ds.organizationId, "dataset:read", { type: "dataset" });
      if (ds.status !== "ready" || !ds.tableName) {
        res.status(409).json({
          error: { code: "CONFLICT", message: `Dataset is ${ds.status}, not ready`, requestId: "", details: {} },
        });
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const requestId = String(res.getHeader("x-request-id") ?? "");
      const result = await dataClient().runQuery(
        grpcCtx(user, ds.organizationId, requestId),
        [ds.id],
        `SELECT * FROM datasets."${ds.tableName}" ORDER BY _row_id`,
        limit + offset,
        deps.statementTimeoutMs,
      );
      const sliced = result.rows.slice(offset).map((row) =>
        Object.fromEntries(
          result.columns.map((c, i) => {
            const raw = row.valuesJson[i];
            let v: unknown = null;
            try {
              v = raw === undefined ? null : JSON.parse(raw);
            } catch {
              v = raw ?? null;
            }
            return [c, v];
          }),
        ),
      );
      res.json({ columns: result.columns, rows: sliced, truncated: result.truncated, durationMs: result.durationMs });
    } catch (e) {
      next(e);
    }
  });

  r.get("/datasets/:datasetId/download", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} } });
        return;
      }
      const dsId = String(req.params.datasetId ?? "");
      const rows = await deps.db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1);
      const ds = rows[0];
      if (!ds || ds.deletedAt) throw notFound("Dataset not found");
      await requireRestAuthorized(deps.db, user, ds.organizationId, "dataset:read", { type: "dataset" });
      // Original CSV is served by streaming through the API (no public bucket).
      res.json({ storageKey: ds.storageKey, note: "Original file download redirects via signed URL" });
    } catch (e) {
      next(e);
    }
  });

  r.delete("/datasets/:datasetId", async (req, res, next) => {
    try {
      const user = await resolveRestUser(deps.auth, req);
      if (!user) {
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} } });
        return;
      }
      const dsId = String(req.params.datasetId ?? "");
      const rows = await deps.db.select().from(datasets).where(eq(datasets.id, dsId)).limit(1);
      const ds = rows[0];
      if (!ds || ds.deletedAt) throw notFound("Dataset not found");
      await requireRestAuthorized(deps.db, user, ds.organizationId, "dataset:write", { type: "dataset" });
      await deps.db
        .update(datasets)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(datasets.id, dsId)));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
