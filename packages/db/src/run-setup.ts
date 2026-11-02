import { loadRootEnv } from "./env";
import { ensureDatabase, setupDatabase } from "./setup";
import { runMigrations } from "./migrate";

const TEST_DB_NAME = "graphite_test";

async function main(): Promise<void> {
  loadRootEnv();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error("DATABASE_ADMIN_URL must be set");
    process.exit(1);
  }

  const adminDb = new URL(adminUrl).pathname.replace(/^\//, "");

  console.info(`Setting up roles and schema on database "${adminDb}"...`);
  await setupDatabase(adminUrl, adminDb);

  console.info(`Ensuring test database "${TEST_DB_NAME}"...`);
  await ensureDatabase(adminUrl, TEST_DB_NAME);

  const testAdminUrl = replaceDbName(adminUrl, TEST_DB_NAME);
  console.info(`Setting up roles and schema on database "${TEST_DB_NAME}"...`);
  await setupDatabase(testAdminUrl, TEST_DB_NAME);

  console.info("Running migrations on main database...");
  await runMigrations(adminUrl);

  console.info("Running migrations on test database...");
  await runMigrations(testAdminUrl);

  console.info("Database setup complete.");
}

function replaceDbName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
