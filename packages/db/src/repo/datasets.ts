import { and, asc, eq } from "drizzle-orm";
import type { DbLike } from "../client";
import { datasets, datasetColumns, type Dataset, type DatasetColumn } from "../schema/index";

/** Internal lookup without org filter; authorize with the returned org id. */
export async function getDatasetById(db: DbLike, datasetId: string): Promise<Dataset | null> {
  const rows = await db.select().from(datasets).where(eq(datasets.id, datasetId)).limit(1);
  return rows[0] ?? null;
}

export async function getDatasetColumns(db: DbLike, datasetId: string): Promise<DatasetColumn[]> {
  return db
    .select()
    .from(datasetColumns)
    .where(and(eq(datasetColumns.datasetId, datasetId)))
    .orderBy(asc(datasetColumns.position));
}
