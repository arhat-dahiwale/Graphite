import { describe, expect, it } from "vitest";
import {
  compileChartQuery,
  parseChartSpec,
  safeParseChartSpec,
  specToEChartsOption,
  type ChartSpec,
} from "../src/index.js";

const validSpec: ChartSpec = {
  version: 1,
  type: "bar",
  title: "Revenue by region",
  datasetId: "ds_abc",
  query: {
    select: [
      { field: "region", as: "region" },
      { agg: "sum", field: "revenue", as: "total_revenue" },
    ],
    groupBy: ["region"],
    orderBy: [{ field: "total_revenue", dir: "desc" }],
    limit: 20,
  },
  encoding: {
    x: { field: "region", type: "category" },
    y: { field: "total_revenue", type: "number", format: "currency" },
  },
  style: { palette: "graphite", legend: false, stack: false },
};

const dataset = {
  tableName: "ds_abc",
  columns: [
    { name: "region", type: "text" as const },
    { name: "revenue", type: "number" as const },
    { name: "ordered_at", type: "date" as const },
  ],
};

describe("chartSpecSchema", () => {
  it("accepts a valid spec (ARCHITECTURE.md example shape)", () => {
    const r = safeParseChartSpec(validSpec);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown fields and bad types", () => {
    expect(safeParseChartSpec({ ...validSpec, type: "wordcloud" }).ok).toBe(false);
    expect(safeParseChartSpec({ ...validSpec, version: 2 }).ok).toBe(false);
    expect(safeParseChartSpec({ ...validSpec, extra: true }).ok).toBe(false);
    expect(safeParseChartSpec({ ...validSpec, query: { select: [] } }).ok).toBe(false);
  });

  it("parseChartSpec throws with a path in the message", () => {
    expect(() => parseChartSpec({ ...validSpec, title: "" })).toThrow(/title/);
  });
});

describe("compileChartQuery", () => {
  it("compiles aggregation + group by + order + limit", () => {
    const { sql } = compileChartQuery(validSpec, dataset);
    expect(sql).toBe(
      'SELECT "region" AS "region", SUM("revenue") AS "total_revenue" FROM datasets."ds_abc" GROUP BY "region" ORDER BY "total_revenue" DESC LIMIT 20',
    );
  });

  it("compiles count and count_distinct", () => {
    const { sql } = compileChartQuery(
      {
        ...validSpec,
        query: {
          select: [
            { field: "region" },
            { agg: "count", field: "region", as: "n" },
            { agg: "count_distinct", field: "revenue", as: "d" },
          ],
          groupBy: ["region"],
        },
      },
      dataset,
    );
    expect(sql).toContain('COUNT(*) AS "n"');
    expect(sql).toContain('COUNT(DISTINCT "revenue") AS "d"');
  });

  it("validates and escapes filter literals", () => {
    const { sql } = compileChartQuery(
      {
        ...validSpec,
        query: {
          select: [{ field: "region" }],
          filter: [
            { field: "region", op: "eq", value: "north" },
            { field: "revenue", op: "gte", value: 10 },
            { field: "ordered_at", op: "lte", value: "2025-06-30" },
            { field: "region", op: "in", value: ["north", "south"] },
          ],
        },
      },
      dataset,
    );
    expect(sql).toContain(`"region" = 'north'`);
    expect(sql).toContain(`"revenue" >= 10`);
    expect(sql).toContain(`"ordered_at" <= '2025-06-30'`);
    expect(sql).toContain(`"region" IN ('north', 'south')`);
  });

  it("escapes single quotes in string literals", () => {
    const { sql } = compileChartQuery(
      {
        ...validSpec,
        query: {
          select: [{ field: "region" }],
          filter: [{ field: "region", op: "eq", value: "o'brien" }],
        },
      },
      dataset,
    );
    expect(sql).toContain("'o''brien'");
  });

  it("rejects unknown fields, unsafe identifiers, bad literals", () => {
    expect(() =>
      compileChartQuery(
        { ...validSpec, query: { select: [{ field: "password_hash" }] } },
        dataset,
      ),
    ).toThrow(/Unknown field/);
    expect(() =>
      compileChartQuery(
        { ...validSpec, query: { select: [{ field: "region; DROP TABLE x" }] } },
        dataset,
      ),
    ).toThrow(/Unsafe field/);
    expect(() =>
      compileChartQuery(
        {
          ...validSpec,
          query: {
            select: [{ field: "region" }],
            filter: [{ field: "revenue", op: "eq", value: "NaN injection" }],
          },
        },
        dataset,
      ),
    ).toThrow(/Invalid number/);
    expect(() =>
      compileChartQuery(
        {
          ...validSpec,
          query: {
            select: [{ field: "region" }],
            filter: [{ field: "region", op: "eq", value: "x' OR '1'='1" }],
          },
        },
        dataset,
      ),
    ).not.toThrow(); // escaped, not rejected — single quotes are doubled
  });

  it("defaults the limit to 1000 and caps at 10000", () => {
    const { sql } = compileChartQuery({ ...validSpec, query: { select: [{ field: "region" }] } }, dataset);
    expect(sql).toContain("LIMIT 1000");
  });
});

describe("specToEChartsOption", () => {
  const data = {
    columns: ["region", "total_revenue"],
    rows: [
      { region: "north", total_revenue: 120.5 },
      { region: "south", total_revenue: 80 },
    ],
  };

  it("renders bar charts on category/number axes", () => {
    const opt = specToEChartsOption(validSpec, data);
    const xAxis = opt.xAxis as { type: string; data?: string[] };
    expect(xAxis.type).toBe("category");
    expect(xAxis.data).toEqual(["north", "south"]);
    const series = opt.series as Array<{ type: string; data: number[] }>;
    expect(series[0]?.type).toBe("bar");
    expect(series[0]?.data).toEqual([120.5, 80]);
  });

  it("renders pie charts as name/value pairs", () => {
    const pie: ChartSpec = {
      ...validSpec,
      type: "pie",
      encoding: { x: { field: "region", type: "category" }, y: { field: "total_revenue", type: "number" } },
    };
    const opt = specToEChartsOption(pie, data);
    const series = opt.series as Array<{ type: string; data: Array<{ name: string; value: number }> }>;
    expect(series[0]?.type).toBe("pie");
    expect(series[0]?.data[0]).toEqual({ name: "north", value: 120.5 });
  });

  it("renders temporal line charts with time axis", () => {
    const line: ChartSpec = {
      ...validSpec,
      type: "line",
      encoding: { x: { field: "ordered_at", type: "temporal" }, y: { field: "total_revenue", type: "number" } },
    };
    const opt = specToEChartsOption(line, { columns: [], rows: [] });
    const xAxis = opt.xAxis as { type: string };
    expect(xAxis.type).toBe("time");
  });
});
