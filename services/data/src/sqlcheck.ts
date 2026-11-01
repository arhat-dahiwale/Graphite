import { Parser } from "node-sql-parser";
import { unprocessable, type AppError } from "@graphite/core";

const parser = new Parser();

export interface SqlCheckInput {
  sql: string;
  /** Allowed fully-qualified or bare table names (e.g. datasets.ds_x, ds_x). */
  allowedTables: string[];
}

export interface SqlCheckResult {
  ok: boolean;
  error?: AppError;
  /** Unqualified table names referenced by the statement. */
  tables: string[];
}

/**
 * Enforce "single SELECT only" plus a table allowlist.
 * - Parse failures are rejected.
 * - Multiple statements are rejected.
 * - Only SELECT is accepted (no CTE/WITH for now; the structured chart query
 *   compiler emits flat SELECTs and `run_sql` exploration works with
 *   subqueries instead).
 * - Every referenced table must belong to the caller's dataset allowlist.
 * - References to other schemas (pg_catalog, information_schema, public) are
 *   rejected by the allowlist.
 */
export function checkSql(input: SqlCheckInput): SqlCheckResult {
  const { sql, allowedTables } = input;
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return { ok: false, tables: [], error: unprocessable("Empty SQL statement") };
  }
  if (sql.length > 100_000) {
    return { ok: false, tables: [], error: unprocessable("SQL statement too long") };
  }
  if (/;/.test(sql.replace(/;\s*$/, ""))) {
    return { ok: false, tables: [], error: unprocessable("Only a single statement is allowed") };
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: "postgresql" });
  } catch {
    return { ok: false, tables: [], error: unprocessable("SQL could not be parsed") };
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { ok: false, tables: [], error: unprocessable("Only a single statement is allowed") };
  }
  const stmt = statements[0] as { type?: string; with?: unknown } | undefined;
  if (!stmt || stmt.type !== "select") {
    return { ok: false, tables: [], error: unprocessable("Only SELECT statements are allowed") };
  }
  if (stmt.with !== undefined && stmt.with !== null) {
    return { ok: false, tables: [], error: unprocessable("CTEs (WITH) are not allowed") };
  }

  let tableRefs: string[] = [];
  try {
    const list = parser.tableList(sql, { database: "postgresql" });
    // Entries look like "select::schema::table" or "insert::..." — filter select refs.
    tableRefs = list
      .map((entry: string) => entry.split("::"))
      .filter((parts) => parts[0] === "select" || parts[0] === "update" || parts[0] === "delete")
      .map((parts) => `${parts[1] && parts[1] !== "null" ? `${parts[1]}.` : ""}${parts[2]}`);
  } catch {
    return { ok: false, tables: [], error: unprocessable("SQL could not be analyzed") };
  }

  const allowedBare = new Set<string>();
  const allowedQualified = new Set<string>();
  for (const t of allowedTables) {
    allowedBare.add(t.toLowerCase());
    const [schema, name] = t.split(".");
    if (schema && name) {
      allowedQualified.add(`${schema.toLowerCase()}.${name.toLowerCase()}`);
      allowedBare.add(name.toLowerCase());
    }
  }

  for (const ref of tableRefs) {
    const lower = ref.toLowerCase();
    const isAllowed =
      allowedQualified.has(lower) ||
      allowedBare.has(lower) ||
      (lower.startsWith("datasets.") && allowedQualified.has(lower));
    // Bare names are fine only when they match the allowlist; anything else
    // (pg_catalog.x, information_schema.x, public.y, unknown.z) is rejected.
    const parts = lower.split(".");
    if (parts.length > 2 || (parts.length === 2 && !allowedQualified.has(lower)) || !isAllowed) {
      return {
        ok: false,
        tables: tableRefs,
        error: unprocessable(`Table ${ref} is not in the allowed list for this request`),
      };
    }
  }

  return { ok: true, tables: tableRefs };
}
