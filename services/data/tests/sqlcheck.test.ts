import { describe, expect, it } from "vitest";
import { checkSql } from "../src/sqlcheck.js";

const ALLOWED = ["datasets.ds_abc123"];

describe("checkSql (SQL safety gate)", () => {
  const run = (sql: string) => checkSql({ sql, allowedTables: ALLOWED });

  it("accepts a simple SELECT on an allowed table", () => {
    const r = run("SELECT region, SUM(revenue) AS total FROM datasets.ds_abc123 GROUP BY region");
    expect(r.ok).toBe(true);
  });

  it("accepts a bare (unqualified) allowed table name", () => {
    const r = run("SELECT * FROM ds_abc123 LIMIT 5");
    expect(r.ok).toBe(true);
  });

  it("accepts subqueries on allowed tables", () => {
    const r = run(
      "SELECT t.region FROM (SELECT region, COUNT(*) AS c FROM datasets.ds_abc123 GROUP BY region) t WHERE t.c > 3",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects writes", () => {
    expect(run("INSERT INTO datasets.ds_abc123 VALUES (1)").ok).toBe(false);
    expect(run("UPDATE datasets.ds_abc123 SET x = 1").ok).toBe(false);
    expect(run("DELETE FROM datasets.ds_abc123").ok).toBe(false);
    expect(run("DROP TABLE datasets.ds_abc123").ok).toBe(false);
    expect(run("TRUNCATE TABLE datasets.ds_abc123").ok).toBe(false);
    expect(run("ALTER TABLE datasets.ds_abc123 ADD COLUMN x int").ok).toBe(false);
    expect(run("CREATE TABLE datasets.evil (x int)").ok).toBe(false);
    expect(run("GRANT ALL ON datasets.ds_abc123 TO public").ok).toBe(false);
  });

  it("rejects multiple statements", () => {
    expect(
      run("SELECT 1 FROM datasets.ds_abc123; DROP TABLE datasets.ds_abc123").ok,
    ).toBe(false);
    expect(run("SELECT 1 FROM datasets.ds_abc123; SELECT 2").ok).toBe(false);
  });

  it("rejects other schemas and cross-tenant tables", () => {
    expect(run("SELECT * FROM public.users").ok).toBe(false);
    expect(run("SELECT * FROM pg_catalog.pg_tables").ok).toBe(false);
    expect(run("SELECT * FROM information_schema.tables").ok).toBe(false);
    expect(run("SELECT * FROM datasets.ds_other").ok).toBe(false);
    expect(run("SELECT * FROM users").ok).toBe(false);
  });

  it("rejects CTEs (conservative scope for v1)", () => {
    expect(
      run("WITH t AS (SELECT 1 FROM datasets.ds_abc123) SELECT * FROM t").ok,
    ).toBe(false);
  });

  it("rejects unparseable and empty SQL", () => {
    expect(run("SELEC 1").ok).toBe(false);
    expect(run("").ok).toBe(false);
  });

  it("does not try to judge function calls (defense-in-depth is role-based)", () => {
    // pg_read_file is a function, not a table: the AST gate passes it, but the
    // read-only Postgres role cannot execute it. Assert the gate stays silent
    // here and the DB layer rejects it (covered in the integration suite).
    expect(run("SELECT pg_read_file('/etc/passwd')").ok).toBe(true);
  });
});
