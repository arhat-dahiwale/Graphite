import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;
/** Transaction handle accepted anywhere a Database is accepted. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbLike = Database | Tx;

export interface DbHandles {
  sql: postgres.Sql;
  db: Database;
}

/** Create an app-role connection (DATABASE_URL). */
export function createDb(url: string, opts?: { max?: number }): DbHandles {
  const sql = postgres(url, {
    max: opts?.max ?? 10,
    prepare: false, // poolers and pgbouncer-friendly
  });
  return { sql, db: drizzle(sql, { schema }) };
}

/** Create an admin-role connection (DATABASE_ADMIN_URL): migrations, DDL setup. */
export function createAdminDb(url: string): DbHandles {
  const sql = postgres(url, { max: 2, prepare: false });
  return { sql, db: drizzle(sql, { schema }) };
}
