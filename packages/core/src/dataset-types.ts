/**
 * Dataset column type domain: inference from CSV samples, value casting, and
 * the Postgres type mapping. Shared by the ingestion worker, the API, and the
 * chart query compiler. Kept free of workspace dependencies.
 */
export type ColumnType = "number" | "integer" | "text" | "boolean" | "date" | "datetime";

export const COLUMN_TYPES: readonly ColumnType[] = [
  "number",
  "integer",
  "text",
  "boolean",
  "date",
  "datetime",
];

/** Postgres type for a dataset column type. */
export function pgTypeFor(type: ColumnType): string {
  switch (type) {
    case "number":
      return "double precision";
    case "integer":
      return "bigint";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    default:
      return "text";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const INTEGER = /^[+-]?\d{1,15}$/;
const NUMBER = /^[+-]?(\d{1,15}(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN = /^(true|false|yes|no|t|f|0|1)$/i;

export function isIntegerLike(v: string): boolean {
  return INTEGER.test(v);
}

export function isNumberLike(v: string): boolean {
  return NUMBER.test(v);
}

export function isDateLike(v: string): boolean {
  return ISO_DATE.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
}

export function isDatetimeLike(v: string): boolean {
  return ISO_DATETIME.test(v) && !Number.isNaN(new Date(v).getTime());
}

export function isBooleanLike(v: string): boolean {
  return BOOLEAN.test(v);
}

/** Parse a raw cell into a typed value for insertion; null when it does not fit.
 * Dates are returned as ISO strings — the parameterized insert casts them with
 * an explicit ::date/::timestamptz, which keeps wire serialization simple. */
export function castCell(raw: string, type: ColumnType): string | number | boolean | null {
  const v = raw.trim();
  if (v === "") return null;
  switch (type) {
    case "integer": {
      if (!INTEGER.test(v)) return null;
      return Number(v);
    }
    case "number": {
      if (!NUMBER.test(v)) return null;
      return Number(v);
    }
    case "boolean": {
      if (!BOOLEAN.test(v)) return null;
      const s = v.toLowerCase();
      return s === "true" || s === "yes" || s === "t" || s === "1";
    }
    case "date": {
      if (!ISO_DATE.test(v)) return null;
      const d = new Date(`${v}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : v;
    }
    case "datetime": {
      if (!ISO_DATETIME.test(v)) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    default:
      return raw;
  }
}

export interface ColumnSpec {
  originalName: string;
  name: string;
  type: ColumnType;
  nullable: boolean;
}

/**
 * Infer a column type from a sample of raw string values, in priority order:
 * boolean > integer > number > date > datetime > text. A column is nullable
 * when any sampled value is empty.
 */
export function inferColumnType(values: string[]): ColumnType {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== "");
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every(isBooleanLike)) return "boolean";
  if (nonEmpty.every(isIntegerLike)) return "integer";
  if (nonEmpty.every(isNumberLike)) return "number";
  if (nonEmpty.every(isDateLike)) return "date";
  if (nonEmpty.every(isDatetimeLike)) return "datetime";
  return "text";
}

export function isNullableSample(values: string[]): boolean {
  return values.some((v) => v.trim() === "");
}
