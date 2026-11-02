import { z } from "zod";

/**
 * The declarative chart spec — the contract that keeps AI output safe to
 * render (ARCHITECTURE.md §4). The agent never writes chart code; it emits a
 * ChartSpec that must pass this schema before it is stored.
 */

export const AGGREGATIONS = ["sum", "avg", "count", "count_distinct", "min", "max"] as const;
export const CHART_TYPES = ["bar", "line", "area", "pie", "histogram"] as const;
export const PALETTES = ["graphite", "ember", "ocean", "forest"] as const;

export const fieldRef = z
  .object({
    field: z.string().min(1).max(100),
    type: z.enum(["category", "temporal", "number"]).optional(),
  })
  .strict();

export const valueRef = z
  .object({
    field: z.string().min(1).max(100),
    type: z.literal("number").default("number"),
    format: z.enum(["number", "currency", "percent"]).optional(),
    agg: z.enum(AGGREGATIONS).optional(),
  })
  .strict();

export const querySchema = z
  .object({
    select: z
      .array(
        z
          .object({
            field: z.string().min(1).max(100),
            as: z.string().min(1).max(100).optional(),
            agg: z.enum(AGGREGATIONS).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    filter: z
      .array(
        z
          .object({
            field: z.string().min(1).max(100),
            op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "like"]),
            value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    groupBy: z.array(z.string().min(1).max(100)).max(10).optional(),
    orderBy: z
      .array(
        z
          .object({
            field: z.string().min(1).max(100),
            dir: z.enum(["asc", "desc"]).default("asc"),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const chartSpecSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(CHART_TYPES),
    title: z.string().min(1).max(200),
    datasetId: z.string().min(1).max(64),
    query: querySchema,
    encoding: z
      .object({
        x: fieldRef,
        y: valueRef.optional(),
        color: z
          .object({
            field: z.string().min(1).max(100).optional(),
            palette: z.enum(PALETTES).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    style: z
      .object({
        palette: z.enum(PALETTES).default("graphite"),
        legend: z.boolean().default(false),
        stack: z.boolean().default(false),
      })
      .strict()
      .default({ palette: "graphite", legend: false, stack: false }),
  })
  .strict();

export type ChartQuery = z.output<typeof querySchema>;
export type ChartSpec = z.output<typeof chartSpecSchema>;
export type ChartType = z.output<typeof chartSpecSchema>["type"];
export type Aggregation = (typeof AGGREGATIONS)[number];

/** Validate untrusted input (model output, MCP tool args) as a ChartSpec. */
export function parseChartSpec(input: unknown): ChartSpec {
  return chartSpecSchema.parse(input);
}

export function safeParseChartSpec(input: unknown): { ok: true; spec: ChartSpec } | { ok: false; error: string } {
  const r = chartSpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: `${first?.path.join(".") ?? "spec"}: ${first?.message ?? "invalid"}` };
}
