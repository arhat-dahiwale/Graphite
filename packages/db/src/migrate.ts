import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/** Apply Drizzle migrations as the admin user. Forward-only; never edited. */
export async function runMigrations(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, prepare: false });
  const db = drizzle(sql);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}
