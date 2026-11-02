import type { ChartSpec } from "./schema";

export interface ChartData {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

const PALETTES: Record<string, string[]> = {
  graphite: ["#71717a", "#a1a1aa", "#d4d4d8", "#52525b", "#3f3f46", "#27272a"],
  ember: ["#f87171", "#fb923c", "#fbbf24", "#f97316", "#ef4444", "#b91c1c"],
  ocean: ["#38bdf8", "#0ea5e9", "#0284c7", "#22d3ee", "#67e8f9", "#0369a1"],
  forest: ["#4ade80", "#22c55e", "#16a34a", "#86efac", "#15803d", "#166534"],
};

/** Dark-theme axis/label defaults shared by every renderer. */
function baseOption(): Record<string, unknown> {
  return {
    backgroundColor: "transparent",
    textStyle: { color: "#a1a1aa" },
    grid: { left: 48, right: 24, top: 32, bottom: 40, containLabel: false },
    animationDuration: 300,
  };
}

function axisFormatter(format: string | undefined): ((v: number) => string) | undefined {
  if (format === "currency") return (v: number) => `$${Number(v).toLocaleString()}`;
  if (format === "percent") return (v: number) => `${Number(v).toFixed(1)}%`;
  return undefined;
}

/**
 * Render a validated ChartSpec + query results into an ECharts option object.
 * This is the single adapter between specs and the renderer; the chart type
 * stays declarative.
 */
export function specToEChartsOption(spec: ChartSpec, data: ChartData): Record<string, unknown> {
  const { encoding, style } = spec;
  const xField = encoding.x.field;
  const yField = encoding.y?.field;
  const option = baseOption();
  const palette = PALETTES[style.palette] ?? PALETTES["graphite"] ?? [];

  if (spec.type === "pie") {
    option.series = [
      {
        type: "pie",
        radius: "70%",
        data: data.rows.map((r) => ({
          name: String(r[xField] ?? ""),
          value: Number(r[yField ?? ""] ?? 0),
        })),
        label: { color: "#d4d4d8" },
        itemStyle: { color: (p: { dataIndex: number }) => palette[p.dataIndex % palette.length] },
      },
    ];
    if (style.legend) {
      option.legend = { bottom: 0, textStyle: { color: "#a1a1aa" } };
    }
    return option;
  }

  // bar / line / area / histogram all render on cartesian axes.
  option.xAxis = {
    type: encoding.x.type === "temporal" ? "time" : "category",
    data: encoding.x.type === "temporal" ? undefined : data.rows.map((r) => String(r[xField] ?? "")),
    axisLabel: { color: "#a1a1aa" },
  };
  option.yAxis = {
    type: "value",
    axisLabel: { color: "#a1a1aa", formatter: axisFormatter(encoding.y?.format) },
  };
  if (style.legend || encoding.color?.field) {
    option.legend = { bottom: 0, textStyle: { color: "#a1a1aa" } };
  }

  const seriesType = spec.type === "histogram" ? "bar" : spec.type === "area" ? "line" : spec.type;
  const series: Record<string, unknown> = {
    type: seriesType,
    data: data.rows.map((r) => Number(r[yField ?? ""] ?? 0)),
    itemStyle: { color: palette[0] },
  };
  if (spec.type === "area") series.areaStyle = { opacity: 0.35 };
  if (style.stack) series.stack = "total";
  if (encoding.color?.field) {
    // Split into one series per color value so ECharts stacks/groups them.
    const byColor = new Map<string, Array<Record<string, unknown>>>();
    data.rows.forEach((r, i) => {
      const key = String(r[encoding.color?.field as string] ?? "");
      if (!byColor.has(key)) byColor.set(key, []);
      const arr = byColor.get(key);
      if (arr) arr.push({ name: String(r[xField] ?? ""), value: Number(r[yField ?? ""] ?? i) });
    });
    option.series = Array.from(byColor.entries()).map(([key, values], i) => ({
      name: key,
      type: seriesType,
      stack: style.stack ? "total" : undefined,
      data: values,
      areaStyle: spec.type === "area" ? { opacity: 0.35 } : undefined,
      itemStyle: { color: palette[i % palette.length] },
    }));
  } else {
    option.series = [series];
  }
  return option;
}
