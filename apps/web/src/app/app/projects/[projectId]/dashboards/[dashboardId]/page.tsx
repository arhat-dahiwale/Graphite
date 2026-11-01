"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import { AnimatePresence, motion } from "framer-motion";
import { trpc } from "@/lib/trpc";
import { ChartRenderer } from "@/components/chart-renderer";
import { AgentPanel } from "@/components/agent-panel";
import { useCollab } from "@/lib/use-collab";
import type { ChartSpec } from "@graphite/chart-spec";

const CHART_TYPES = ["bar", "line", "area", "pie", "histogram"] as const;

export default function DashboardPage({
  params,
}: {
  params: Promise<{ projectId: string; dashboardId: string }>;
}) {
  const { projectId, dashboardId } = use(params);
  const utils = trpc.useUtils();
  const { containerRef, width, mounted } = useContainerWidth();

  const dashboardQuery = trpc.dashboard.get.useQuery({ dashboardId });
  const datasetsQuery = trpc.dataset.list.useQuery({ projectId });
  const createChart = trpc.chart.create.useMutation({
    onSuccess: () => utils.dashboard.get.invalidate({ dashboardId }),
  });

  // Live collaboration: presence, cursors, remote layout writes, agent/MCP
  // chart events.
  const collab = useCollab(dashboardId);

  // Reconcile remote layout writes from other users.
  const lastRemoteVersion = useRef(0);
  useEffect(() => {
    const remote = collab.remoteLayout;
    if (!remote || remote.layoutVersion === lastRemoteVersion.current) return;
    lastRemoteVersion.current = remote.layoutVersion;
    baseVersionRef.current = remote.layoutVersion;
    void utils.dashboard.get.invalidate({ dashboardId });
  }, [collab.remoteLayout, dashboardId, utils.dashboard.get]);

  // Refresh when agent or MCP runs create/update chart versions.
  useEffect(() => {
    if (collab.chartVersionEvent) {
      void utils.dashboard.get.invalidate({ dashboardId });
    }
  }, [collab.chartVersionEvent, dashboardId, utils.dashboard.get]);

  // Refresh when a chart is added to the dashboard from outside this browser
  // (MCP client, another member, agent).
  useEffect(() => {
    if (collab.chartAddedEvent) {
      void utils.dashboard.get.invalidate({ dashboardId });
    }
  }, [collab.chartAddedEvent, dashboardId, utils.dashboard.get]);

  const saveLayout = trpc.dashboard.saveLayout.useMutation({
    onSuccess: (result) => {
      if (result.ok) {
        baseVersionRef.current = result.layoutVersion;
        setConflict(null);
      } else {
        setConflict(`Someone else moved things just before you (v${result.currentVersion}). Reloading their layout.`);
        baseVersionRef.current = result.currentVersion;
        void utils.dashboard.get.invalidate({ dashboardId });
      }
    },
    onError: (e) => setConflict(e.message),
  });

  const baseVersionRef = useRef(dashboardQuery.data?.layout.layoutVersion ?? 1);
  const [conflict, setConflict] = useState<string | null>(null);
  void collab;
  const [builderOpen, setBuilderOpen] = useState(false);
  const [historyChartId, setHistoryChartId] = useState<string | null>(null);
  const [remakeChartId, setRemakeChartId] = useState<string | null>(null);

  const charts = dashboardQuery.data?.charts ?? [];
  const layoutVersion = dashboardQuery.data?.layout.layoutVersion ?? 1;
  baseVersionRef.current = layoutVersion;

  const rglLayout: Layout = useMemo(
    () =>
      charts.map((c) => ({
        i: c.chart.id,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
      })),
    [charts],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayoutChange = useCallback(
    (layout: Layout) => {
      if (!dashboardQuery.data) return;
      // Only save when something actually moved (skip the initial compaction).
      const current = new Map(dashboardQuery.data.charts.map((c) => [c.chart.id, c]));
      const changed = layout.some((l) => {
        const c = current.get(l.i);
        return !c || c.x !== l.x || c.y !== l.y || c.w !== l.w || c.h !== l.h;
      });
      if (!changed) return;
      // Debounce: RGL fires onLayoutChange during drags; one gesture = one save.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveLayout.mutate({
          dashboardId,
          baseVersion: baseVersionRef.current,
          items: layout.map((l, idx) => ({
            chartId: l.i,
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            z: idx,
          })),
        });
      }, 400);
    },
    [dashboardId, dashboardQuery.data, saveLayout],
  );

  const removeChart = trpc.chart.removeFromDashboard.useMutation({
    onSuccess: () => utils.dashboard.get.invalidate({ dashboardId }),
  });

  return (
    <div className="flex h-full">
      <div className="mx-auto max-w-7xl flex-1 space-y-4 px-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link
            href={`/app/projects/${projectId}`}
            className="text-sm text-zinc-500 underline-offset-2 hover:underline"
          >
            ← Datasets
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {dashboardQuery.data?.dashboard.name ?? "Dashboard"}
          </h1>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-500">
            layout v{layoutVersion}
          </span>
        </div>
        <button
          onClick={() => setBuilderOpen(true)}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          + Add chart
        </button>
      </header>

      {conflict && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
          {conflict}
        </div>
      )}

      {dashboardQuery.isLoading ? (
        <p className="text-zinc-500">Loading dashboard…</p>
      ) : charts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 p-12 text-center text-sm text-zinc-500">
          No charts yet. Add one from a dataset — or ask the agent later.
        </div>
      ) : (
        <div ref={containerRef}>
          <AnimatePresence mode="popLayout">
            <GridLayout
              key={mounted ? "measured" : "initial"}
              className="layout"
              layout={rglLayout}
              width={width || 1200}
              gridConfig={{ cols: 12, rowHeight: 64, margin: [12, 12] }}
              dragConfig={{ enabled: true, handle: ".chart-drag-handle" }}
              resizeConfig={{ enabled: true }}
              onLayoutChange={onLayoutChange}
            >
              {charts.map((c) => (
                <motion.div
                  key={c.chart.id}
                  layout
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
                >
                  <ChartCard
                    chartId={c.chart.id}
                    title={c.chart.title}
                    source={c.version?.source ?? "manual"}
                    versionNumber={c.version?.versionNumber ?? 0}
                    onRemove={() => removeChart.mutate({ dashboardId, chartId: c.chart.id })}
                    onHistory={() => setHistoryChartId(c.chart.id)}
                    onRemake={() => setRemakeChartId(c.chart.id)}
                  />
                </motion.div>
              ))}
            </GridLayout>
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {builderOpen && (
          <ChartBuilder
            datasets={datasetsQuery.data ?? []}
            onClose={() => setBuilderOpen(false)}
            onCreate={async (input) => {
              const maxY = charts.length > 0 ? Math.max(...charts.map((c) => c.y + c.h)) : 0;
              await createChart.mutateAsync({
                datasetId: input.datasetId,
                spec: input.spec,
                dashboardId,
                position: { x: 0, y: maxY, w: 6, h: 4 },
              });
              setBuilderOpen(false);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {historyChartId && (
          <VersionHistory
            chartId={historyChartId}
            onClose={() => setHistoryChartId(null)}
            onReverted={() => {
              void utils.dashboard.get.invalidate({ dashboardId });
              setHistoryChartId(null);
            }}
          />
        )}
      </AnimatePresence>

      </div>
      <AgentPanel
        dashboardId={dashboardId}
        remakeChartId={remakeChartId}
        onClearRemake={() => setRemakeChartId(null)}
      />
    </div>
  );
}

function ChartCard({
  chartId,
  title,
  source,
  versionNumber,
  onRemove,
  onHistory,
  onRemake,
}: {
  chartId: string;
  title: string;
  source: string;
  versionNumber: number;
  onRemove: () => void;
  onHistory: () => void;
  onRemake: () => void;
}) {
  const dataQuery = trpc.chart.data.useQuery({ chartId });
  const getQuery = trpc.chart.get.useQuery({ chartId });
  const versionSpec = getQuery.data?.version?.spec as ChartSpec | undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="chart-drag-handle flex cursor-grab items-center justify-between border-b border-zinc-800 px-3 py-2 active:cursor-grabbing">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-600">
            v{versionNumber} · {source}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={onHistory} className="text-zinc-500 underline hover:text-zinc-300">
            history
          </button>
          <button onClick={onRemake} className="text-zinc-500 underline hover:text-emerald-300">
            re-make
          </button>
          <button onClick={onRemove} className="text-zinc-500 underline hover:text-red-400">
            remove
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChartRenderer
          spec={versionSpec as ChartSpec}
          data={dataQuery.data ?? null}
          loading={dataQuery.isLoading}
          error={dataQuery.error?.message ?? null}
        />
      </div>
    </div>
  );
}

interface BuilderInput {
  datasetId: string;
  spec: ChartSpec;
}

function ChartBuilder({
  datasets,
  onClose,
  onCreate,
}: {
  datasets: Array<{ id: string; name: string; status: string }>;
  onClose: () => void;
  onCreate: (input: BuilderInput) => Promise<void>;
}) {
  const ready = datasets.filter((d) => d.status === "ready");
  const [datasetId, setDatasetId] = useState(ready[0]?.id ?? "");
  const datasetDetail = trpc.dataset.get.useQuery(
    { datasetId },
    { enabled: !!datasetId },
  );
  const columns = datasetDetail.data?.columns ?? [];
  const [title, setTitle] = useState("New chart");
  const [type, setType] = useState<(typeof CHART_TYPES)[number]>("bar");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [agg, setAgg] = useState<"sum" | "avg" | "count" | "min" | "max" | "count_distinct">("sum");
  const [groupBy, setGroupBy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const xCol = columns.find((c) => c.name === xField);
  const xType =
    xCol && (xCol.userType ?? xCol.inferredType) === "date"
      ? "temporal"
      : xCol && ["number", "integer"].includes(xCol.userType ?? xCol.inferredType)
        ? "number"
        : "category";

  async function submit(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const spec: ChartSpec = {
        version: 1,
        type,
        title,
        datasetId,
        query: {
          select: [
            { field: xField },
            ...(type === "pie" || yField
              ? [{ field: yField || xField, agg: type === "histogram" ? ("count" as const) : agg, as: "value" }]
              : []),
          ],
          groupBy: groupBy ? [xField] : undefined,
          orderBy: [{ field: "value", dir: "desc" as const }],
          limit: 500,
        },
        encoding: {
          x: { field: xField, type: xType as "category" | "temporal" | "number" },
          y: { field: yField || xField, type: "number" as const },
        },
        style: { palette: "graphite", legend: false, stack: false },
      };
      await onCreate({ datasetId, spec });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="w-full max-w-lg space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New chart</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Dataset">
            <select
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            >
              {ready.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            />
          </Field>
          <Field label="Chart type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as (typeof CHART_TYPES)[number])}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            >
              {CHART_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="X field">
            <select
              value={xField}
              onChange={(e) => setXField(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            >
              <option value="">(pick a column)</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.originalName} ({c.userType ?? c.inferredType})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Y field (numeric)">
            <select
              value={yField}
              onChange={(e) => setYField(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            >
              <option value="">count rows</option>
              {columns
                .filter((c) => ["number", "integer"].includes(c.userType ?? c.inferredType))
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.originalName}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Aggregation">
            <select
              value={agg}
              onChange={(e) => setAgg(e.target.value as typeof agg)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5"
            >
              {["sum", "avg", "count", "min", "max", "count_distinct"].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={groupBy} onChange={(e) => setGroupBy(e.target.checked)} />
          Group by X field
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!datasetId || !xField || pending}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create chart"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function VersionHistory({
  chartId,
  onClose,
  onReverted,
}: {
  chartId: string;
  onClose: () => void;
  onReverted: () => void;
}) {
  const versions = trpc.chart.versions.useQuery({ chartId });
  const revert = trpc.chart.revert.useMutation({ onSuccess: onReverted });
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        className="w-full max-w-lg space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Version history</h2>
        <ul className="max-h-80 divide-y divide-zinc-800 overflow-y-auto rounded-lg border border-zinc-800">
          {(versions.data ?? []).map((v) => {
            const spec = v.spec as ChartSpec;
            return (
              <li key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">
                    v{v.versionNumber}{" "}
                    <span className="text-xs uppercase text-zinc-500">{v.source}</span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    {spec.title} · {spec.type} · {new Date(v.createdAt).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => revert.mutate({ chartId, versionId: v.id })}
                  disabled={revert.isPending}
                  className="text-zinc-400 underline hover:text-zinc-200 disabled:opacity-50"
                >
                  revert
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end">
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-4 py-2 text-sm">
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
