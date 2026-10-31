import { afterAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "@graphite/core/config";
import { createDb } from "../src/client.js";

loadRootEnv();

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "";
if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set for db tests");

/** Same host as the admin URL but the integration-test database. */
function asUrlFor(dbName: string, username: string, password: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = username;
  u.password = password;
  return u.toString();
}

const TEST_DB = "graphite_test";
const handles = createDb(asUrlFor(TEST_DB, "graphite_app", "app_password"));
const { sql } = handles;

afterAll(async () => {
  await sql.end();
});

describe("database bootstrap", () => {
  it("app role can query migrated public tables", async () => {
    const rows = await sql`SELECT COUNT(*)::int AS n FROM organizations`;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(0);
  });

  it("readonly role is denied SELECT on public tables", async () => {
    const ro = createDb(asUrlFor(TEST_DB, "graphite_readonly", "readonly_password"));
    try {
      await expect(async () => {
        await ro.sql`SELECT 1 FROM public.users LIMIT 1`;
      }).rejects.toThrow(/permission denied/i);
    } finally {
      await ro.sql.end();
    }
  });

  it("app role can create, grant on, and drop tables in the datasets schema", async () => {
    await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS datasets.ds_smoke_test (_row_id bigserial primary key, v text)",
    );
    await sql.unsafe("GRANT SELECT ON datasets.ds_smoke_test TO graphite_readonly");
    await sql.unsafe("DROP TABLE IF EXISTS datasets.ds_smoke_test");
    expect(true).toBe(true);
  });
});
