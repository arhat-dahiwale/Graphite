import type { ChartSpec } from "./schema";

export interface DatasetColumnMeta {
  name: string;
  type: "number" | "integer" | "text" | "boolean" | "date" | "datetime";
}

export interface CompileDataset {
  tableName: string;
  columns: DatasetColumnMeta[];
}

export interface CompiledQuery {
  sql: string;
  grouped: boolean;
}

const IDENT = /^[a-z0-9_]+$/i;

function assertIdentifier(name: string, label: string): string {
  if (!IDENT.test(name) || name.length > 63) {
    throw new Error(`Unsafe ${label}: ${name.slice(0, 40)}`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${assertIdentifier(name, "identifier")}"`;
}

function aliasFor(field: string, agg: string | undefined, as: string | undefined): string {
  const base = as ?? (agg && agg !== "count" ? `${agg}_${field}` : field);
  return assertIdentifier(base, "alias");
}

/**
 * Compile a spec's structured query into a single safe SELECT against the
 * dataset table. Fields are validated against the dataset's columns; literal
 * values are strictly validated/escaped (the data service runs the result
 * through an AST check again, so both layers must agree).
 */
export function compileChartQuery(spec: ChartSpec, dataset: CompileDataset): CompiledQuery {
  const cols = new Map(dataset.columns.map((c) => [c.name, c]));
  const table = quoteIdent(dataset.tableName);

  const selectParts = spec.query.select.map((s) => {
    const field = assertIdentifier(s.field, "field");
    if (!cols.has(field)) throw new Error(`Unknown field: ${field}`);
    const alias = aliasFor(field, s.agg, s.as);
    if (s.agg === "count") return `COUNT(*) AS ${quoteIdent(alias)}`;
    if (s.agg === "count_distinct") return `COUNT(DISTINCT ${quoteIdent(field)}) AS ${quoteIdent(alias)}`;
    if (s.agg) {
      const fn = s.agg.toUpperCase();
      return `${fn}(${quoteIdent(field)}) AS ${quoteIdent(alias)}`;
    }
    return `${quoteIdent(field)} AS ${quoteIdent(alias)}`;
  });

  const whereParts = (spec.query.filter ?? []).map((f) => {
    const field = assertIdentifier(f.field, "field");
    const col = cols.get(field);
    if (!col) throw new Error(`Unknown field: ${field}`);
    const lit = (v: string | number | boolean): string => {
      switch (col.type) {
        case "number":
        case "integer": {
          const n = typeof v === "number" ? v : Number(v);
          if (!Number.isFinite(n)) throw new Error(`Invalid number for ${field}`);
          return String(n);
        }
        case "boolean": {
          if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
          if (v === "true" || v === "1") return "TRUE";
          if (v === "false" || v === "0") return "FALSE";
          throw new Error(`Invalid boolean for ${field}`);
        }
        case "date":
        case "datetime": {
          const s = String(v);
          if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
            throw new Error(`Invalid date literal for ${field}`);
          }
          return `'${s}'`;
        }
        default: {
          const s = String(v);
          if (s.includes("\0")) throw new Error(`Invalid string for ${field}`);
          return `'${s.replace(/'/g, "''")}'`;
        }
      }
    };
    switch (f.op) {
      case "eq":
        return `${quoteIdent(field)} = ${lit(f.value as string | number | boolean)}`;
      case "neq":
        return `${quoteIdent(field)} <> ${lit(f.value as string | number | boolean)}`;
      case "gt":
        return `${quoteIdent(field)} > ${lit(f.value as string | number | boolean)}`;
      case "gte":
        return `${quoteIdent(field)} >= ${lit(f.value as string | number | boolean)}`;
      case "lt":
        return `${quoteIdent(field)} < ${lit(f.value as string | number | boolean)}`;
      case "lte":
        return `${quoteIdent(field)} <= ${lit(f.value as string | number | boolean)}`;
      case "in": {
        const values = f.value as Array<string | number>;
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`'in' filter requires a non-empty list`);
        }
        if (values.length > 1000) throw new Error(`'in' filter too large`);
        return `${quoteIdent(field)} IN (${values.map((v) => lit(v)).join(", ")})`;
      }
      case "like": {
        const s = String(f.value).replace(/\0/g, "");
        return `${quoteIdent(field)} LIKE '${s.replace(/'/g, "''")}'`;
      }
      default:
        throw new Error(`Unsupported filter op`);
    }
  });

  const groupBy = (spec.query.groupBy ?? []).map((g) => {
    const field = assertIdentifier(g, "field");
    if (!cols.has(field)) throw new Error(`Unknown field: ${field}`);
    return quoteIdent(field);
  });

  const orderBy = (spec.query.orderBy ?? []).map((o) => {
    const field = assertIdentifier(o.field, "field");
    return `${quoteIdent(field)} ${o.dir === "desc" ? "DESC" : "ASC"}`;
  });

  const limit = Math.min(spec.query.limit ?? 1000, 10_000);

  const parts = [`SELECT ${selectParts.join(", ")}`, `FROM datasets.${table}`];
  if (whereParts.length > 0) parts.push(`WHERE ${whereParts.join(" AND ")}`);
  if (groupBy.length > 0) parts.push(`GROUP BY ${groupBy.join(", ")}`);
  if (orderBy.length > 0) parts.push(`ORDER BY ${orderBy.join(", ")}`);
  parts.push(`LIMIT ${limit}`);
  return { sql: parts.join(" "), grouped: groupBy.length > 0 };
}
