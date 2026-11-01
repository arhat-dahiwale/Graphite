import { describe, expect, it } from "vitest";
import {
  castCell,
  dedupeColumnNames,
  inferColumnType,
  pgTypeFor,
  sanitizeColumnName,
} from "@graphite/core";

describe("inferColumnType", () => {
  it("detects integer, number, boolean, date, datetime, text", () => {
    expect(inferColumnType(["1", "2", "3"])).toBe("integer");
    expect(inferColumnType(["1.5", "2", "3.25"])).toBe("number");
    expect(inferColumnType(["true", "false", "false"])).toBe("boolean");
    expect(inferColumnType(["2025-01-01", "2025-02-15"])).toBe("date");
    expect(inferColumnType(["2025-01-01T10:00:00Z", "2025-02-15T23:59:59Z"])).toBe("datetime");
    expect(inferColumnType(["north", "south", "east"])).toBe("text");
  });

  it("degrades gracefully when one value breaks the pattern", () => {
    expect(inferColumnType(["1", "2", "oops"])).toBe("text");
    expect(inferColumnType(["2025-01-01", "not-a-date"])).toBe("text");
  });

  it("empty columns and empty strings are text/nullable", () => {
    expect(inferColumnType([])).toBe("text");
    expect(inferColumnType(["", ""])).toBe("text");
  });

  it("prioritizes integer over number", () => {
    expect(inferColumnType(["10", "-3"])).toBe("integer");
  });
});

describe("castCell", () => {
  it("casts values and nulls non-fitting cells", () => {
    expect(castCell("42", "integer")).toBe(42);
    expect(castCell("42.5", "integer")).toBeNull();
    expect(castCell(" 1.5 ", "number")).toBe(1.5);
    expect(castCell("TRUE", "boolean")).toBe(true);
    expect(castCell("0", "boolean")).toBe(false);
    expect(castCell("2025-03-01", "date")).toBe("2025-03-01");
    expect(castCell("not a date", "date")).toBeNull();
    expect(castCell("", "text")).toBeNull();
    expect(castCell("hello", "text")).toBe("hello");
  });
});

describe("sanitizeColumnName", () => {
  it("lowercases and replaces unsafe characters", () => {
    expect(sanitizeColumnName("Total Revenue ($) 2025", 0)).toBe("total_revenue_2025");
  });

  it("handles leading digits and empty names", () => {
    expect(sanitizeColumnName("123abc", 4)).toBe("col_4");
    expect(sanitizeColumnName("!!!", 7)).toBe("col_7");
  });

  it("dedupes collisions deterministically", () => {
    expect(dedupeColumnNames(["a", "a", "a"])).toEqual(["a", "a_2", "a_3"]);
  });
});

describe("pgTypeFor", () => {
  it("maps every column type to a Postgres type", () => {
    expect(pgTypeFor("integer")).toBe("bigint");
    expect(pgTypeFor("number")).toBe("double precision");
    expect(pgTypeFor("datetime")).toBe("timestamptz");
    expect(pgTypeFor("text")).toBe("text");
  });
});
