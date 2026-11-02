import { z } from "zod";
import { badRequest, notFound, unprocessable } from "@graphite/core";
import { pgTypeFor } from "@graphite/core";
import { datasets, datasetColumns } from "@graphite/db/schema";
import { getProjectById } from "@graphite/db/repo/projects";
import { and, asc, eq, isNull } from "drizzle-orm";
import { authedProcedure, router, toTrpcError } from "../trpc";
import { requireAuthorized } from "../authz-helpers";

const columnTypeSchema = z.enum(["number", "integer", "text", "boolean", "date", "datetime"]);

export const datasetRouter = router({
  list: authedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const project = await getProjectById(ctx.db, input.projectId);
        if (!project || project.deletedAt) throw notFound();
        await requireAuthorized(ctx, project.organizationId, "project:read", { type: "project" });
        return ctx.db
          .select()
          .from(datasets)
          .where(and(eq(datasets.projectId, input.projectId), isNull(datasets.deletedAt)))
          .orderBy(asc(datasets.createdAt));
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ datasetId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const rows = await ctx.db
          .select()
          .from(datasets)
          .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
          .limit(1);
        const ds = rows[0];
        if (!ds) throw notFound();
        await requireAuthorized(ctx, ds.organizationId, "dataset:read", { type: "dataset" });
        const columns = await ctx.db
          .select()
          .from(datasetColumns)
          .where(eq(datasetColumns.datasetId, ds.id))
          .orderBy(asc(datasetColumns.position));
        return { dataset: ds, columns };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  rename: authedProcedure
    .input(z.object({ datasetId: z.string().min(1), name: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const rows = await ctx.db
          .select()
          .from(datasets)
          .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
          .limit(1);
        const ds = rows[0];
        if (!ds) throw notFound();
        await requireAuthorized(ctx, ds.organizationId, "dataset:write", { type: "dataset" });
        const updated = await ctx.db
          .update(datasets)
          .set({ name: input.name, updatedAt: new Date() })
          .where(eq(datasets.id, ds.id))
          .returning();
        return updated[0];
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  updateColumnType: authedProcedure
    .input(
      z.object({
        datasetId: z.string().min(1),
        columnName: z.string().min(1).max(100),
        columnType: columnTypeSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const rows = await ctx.db
          .select()
          .from(datasets)
          .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
          .limit(1);
        const ds = rows[0];
        if (!ds) throw notFound();
        await requireAuthorized(ctx, ds.organizationId, "dataset:write", { type: "dataset" });
        if (ds.status !== "ready" || !ds.tableName) {
          throw badRequest("Dataset is not ready");
        }
        const colRows = await ctx.db
          .select()
          .from(datasetColumns)
          .where(
            and(
              eq(datasetColumns.datasetId, ds.id),
              eq(datasetColumns.name, input.columnName),
            ),
          )
          .limit(1);
        const column = colRows[0];
        if (!column) throw notFound("Column not found");

        // Apply the physical cast. Identifiers are validated DB names; the type
        // comes from a fixed enum. Cast failures surface as 422.
        const pgType = pgTypeFor(input.columnType);
        const table = `datasets."${ds.tableName}"`;
        const col = `"${column.name}"`;
        try {
          await ctx.sql.unsafe(
            `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${pgType} USING NULLIF(${col}::text, '')::${pgType}`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "cast failed";
          throw unprocessable(
            `Could not cast column "${column.originalName}" to ${input.columnType}: ${msg.slice(0, 200)}`,
          );
        }

        const updated = await ctx.db
          .update(datasetColumns)
          .set({ userType: input.columnType })
          .where(eq(datasetColumns.id, column.id))
          .returning();
        return updated[0];
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
