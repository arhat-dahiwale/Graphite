import { loadRootEnv } from "./env.js";
import { runMigrations } from "./migrate.js";

async function main(): Promise<void> {
  loadRootEnv();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error("DATABASE_ADMIN_URL must be set");
    process.exit(1);
  }
  await runMigrations(adminUrl);
  console.info("Migrations applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
