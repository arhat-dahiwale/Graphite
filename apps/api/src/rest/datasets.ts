import { Router } from "express";
import multer from "multer";
import { createReadStream, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppError, isAppError, newId, payloadTooLarge, unprocessable } from "@graphite/core";
import { datasets, projects } from "@graphite/db/schema";
import { eq } from "drizzle-orm";
import { uploadStream } from "@graphite/storage";
import type { Queue } from "bullmq";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import type { GraphiteAuth } from "../auth";
import { resolveRestUser, requireRestAuthorized } from "./auth";

export interface DatasetsRestDeps {
  db: Database;
  sql: Sql;
  auth?: GraphiteAuth;
  storage: S3Client;
  bucket: string;
  ingestionQueue: Queue;
  maxUploadMb: number;
}

/**
 * Dataset upload: POST /api/v1/projects/:projectId/datasets (multipart, field
 * "file"). Streams the file to object storage, creates the dataset row, and
 * enqueues the idempotent ingestion job. Returns 202 with the dataset and jobId.
 */
export function datasetsRestRouter(deps: DatasetsRestDeps): Router {
  const r = Router();

  const uploader = multer({
    dest: os.tmpdir(),
    limits: { fileSize: deps.maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (path.extname(file.originalname).toLowerCase() !== ".csv") {
        cb(new AppError("UNPROCESSABLE", "Only .csv files are supported"));
        return;
      }
      cb(null, true);
    },
  });

  r.post(
    "/projects/:projectId/datasets",
    (req, res, next) => {
      uploader.single("file")(req, res, (err) => {
        if (!err) {
          next();
          return;
        }
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          next(payloadTooLarge(`Upload exceeds ${deps.maxUploadMb} MB`));
        } else if (isAppError(err)) {
          next(err);
        } else {
          next(new AppError("BAD_REQUEST", "Upload failed", { cause: err }));
        }
      });
    },
    async (req, res, next) => {
      const tmpPath = req.file?.path;
      try {
        const user = await resolveRestUser(deps.auth, req);
        if (!user) {
          res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Sign in required", requestId: "", details: {} },
          });
          return;
        }
        const projectId = String(req.params.projectId ?? "");
        const projectRows = await deps.db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const project = projectRows[0];
        if (!project || project.deletedAt) throw new AppError("NOT_FOUND", "Project not found");

        await requireRestAuthorized(deps.db, user, project.organizationId, "dataset:write", {
          type: "dataset",
        });

        const file = req.file;
        if (!file) throw unprocessable("Missing file field");

        const dsId = newId("ds");
        const storageKey = `uploads/${project.organizationId}/${dsId}.csv`;
        const name =
          typeof req.body?.name === "string" && req.body.name.trim().length > 0
            ? req.body.name.trim().slice(0, 200)
            : path.basename(file.originalname);

        const inserted = await deps.db
          .insert(datasets)
          .values({
            id: dsId,
            organizationId: project.organizationId,
            projectId,
            name,
            originalFilename: file.originalname,
            storageKey,
            status: "uploading",
            sizeBytes: file.size,
            createdBy: user.id,
          })
          .returning();
        const dataset = inserted[0];
        if (!dataset) throw new AppError("INTERNAL", "Failed to create dataset row");

        await uploadStream(deps.storage, deps.bucket, storageKey, createReadStream(tmpPath as string));

        await deps.db
          .update(datasets)
          .set({ status: "queued", updatedAt: new Date() })
          .where(eq(datasets.id, dsId));

        const jobId = `ingest-${dsId}`;
        await deps.ingestionQueue.add(
          "ingest",
          { datasetId: dsId },
          { jobId, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 100 },
        );

        res.status(202).json({
          dataset: {
            id: dsId,
            status: "queued",
            name,
            projectId,
            organizationId: project.organizationId,
          },
          jobId,
        });
      } catch (e) {
        next(e);
      } finally {
        if (tmpPath) {
          try {
            unlinkSync(tmpPath);
          } catch {
            // best effort cleanup
          }
        }
      }
    },
  );

  return r;
}
