import { loadRootEnv } from "./env";
import { runMigrations } from "./migrate";

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
