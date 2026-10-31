import postgres from "postgres";

/**
 * Idempotent database bootstrap: Postgres roles, the `datasets` schema, and
 * grants. Runs as the admin user. Safe to run repeatedly and against both the
 * main and the integration-test database.
 *
 * - graphite_app: app role, read/write on public, create/write on datasets schema
 * - graphite_readonly: SELECT-only on datasets schema, statement_timeout at role level
 */
export async function setupDatabase(adminUrl: string, databaseName: string): Promise<void> {
  // 1) Cluster-level roles (connect to any DB; roles are cluster objects).
  {
    const sql = postgres(adminUrl, { max: 1, prepare: false });
    try {
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graphite_app') THEN
            CREATE ROLE graphite_app LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graphite_readonly') THEN
            CREATE ROLE graphite_readonly LOGIN PASSWORD 'readonly_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
          END IF;
        END
        $$;
      `);
      await sql.unsafe(`ALTER ROLE graphite_readonly SET statement_timeout = '10s'`);
      await sql.unsafe(`ALTER ROLE graphite_app SET statement_timeout = '30s'`);
    } finally {
      await sql.end();
    }
  }

  // 2) Per-database schema and grants.
  {
    const sql = postgres(adminUrl, { max: 1, prepare: false });
    try {
      await sql.unsafe(`
        CREATE SCHEMA IF NOT EXISTS datasets;
        GRANT CONNECT ON DATABASE ${quoteIdent(databaseName)} TO graphite_app, graphite_readonly;
        GRANT USAGE, CREATE ON SCHEMA public TO graphite_app;
        GRANT USAGE, CREATE ON SCHEMA datasets TO graphite_app;
        GRANT USAGE ON SCHEMA datasets TO graphite_readonly;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO graphite_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO graphite_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA datasets GRANT ALL ON TABLES TO graphite_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA datasets GRANT ALL ON SEQUENCES TO graphite_app;
      `);
    } finally {
      await sql.end();
    }
  }
}

/** Parse a postgres URL and connect as admin to the same host to create a DB. */
export async function ensureDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const url = new URL(adminUrl);
  if (url.pathname.replace(/^\//, "") === databaseName) return;
  url.pathname = "/postgres";
  const sql = postgres(url.toString(), { max: 1, prepare: false });
  try {
    const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (exists.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    }
  } finally {
    await sql.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}
