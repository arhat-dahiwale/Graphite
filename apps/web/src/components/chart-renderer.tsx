"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { specToEChartsOption, type ChartSpec } from "@graphite/chart-spec";

export interface ChartRendererProps {
  spec: ChartSpec;
  data: { columns: string[]; rows: Array<Record<string, unknown>> } | null;
  loading?: boolean;
  error?: string | null;
}

/** ECharts renderer bound to a ChartSpec through the single adapter. */
export function ChartRenderer({ spec, data, loading, error }: ChartRendererProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  /**
   * Export this chart's canvas as a PNG (ECharts getDataURL). Used by the
   * dashboard "Export PNG" action; no server round-trip.
   */
  function exportPng(): void {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#101013" });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${spec.title.replace(/[^\w-]+/g, "_")}.png`;
    a.click();
  }

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const onResize = (): void => chart.resize();
    const observer = new ResizeObserver(onResize);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (error) {
      chart.clear();
      return;
    }
    if (data) {
      chart.setOption(specToEChartsOption(spec, data), true);
    }
  }, [spec, data, error]);

  return (
    <div className="relative h-full w-full">
      <div ref={ref} className="h-full w-full" />
      <button
        onClick={exportPng}
        aria-label={`Download ${spec.title} as PNG`}
        className="absolute right-2 top-2 z-10 rounded border border-zinc-700 bg-zinc-950/80 px-2 py-0.5 text-[10px] text-zinc-400 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
      >
        PNG
      </button>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
          Loading…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
