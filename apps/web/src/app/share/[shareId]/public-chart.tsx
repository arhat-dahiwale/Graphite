"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ChartSpec, specToEChartsOption } from "@graphite/chart-spec";

/** Client-side ECharts render for the public share view. */
export function PublicChart({
  spec,
  option,
}: {
  spec: ChartSpec;
  option: ReturnType<typeof specToEChartsOption>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(option);
    const onResize = (): void => chart.resize();
    const observer = new ResizeObserver(onResize);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option, spec]);

  return <div ref={ref} className="h-full w-full min-h-[180px]" role="img" aria-label={`Chart: ${spec.title}`} />;
}
