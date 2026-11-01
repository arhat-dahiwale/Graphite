"use client";

import { use, useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

interface PreviewData {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

interface DatasetEventBody {
  type?: string;
  data?: { stage?: string; rowsProcessed?: number; percent?: number; rowCount?: number };
}

export default function DatasetPage({
  params,
}: {
  params: Promise<{ projectId: string; datasetId: string }>;
}) {
  const { datasetId } = use(params);
  const utils = trpc.useUtils();
  const query = trpc.dataset.get.useQuery(
    { datasetId },
    {
      refetchInterval: (q) => {
        const status = q.state.data?.dataset.status;
        return status === "ready" || status === "failed" ? false : 1000;
      },
    },
  );

  const dataset = query.data?.dataset;
  const columns = query.data?.columns ?? [];
  const isReady = dataset?.status === "ready";

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [progress, setProgress] = useState(0);

  // Live ingestion progress over SSE while not ready.
  useEffect(() => {
    if (isReady || !dataset) return;
    const es = new EventSource(`/api/v1/datasets/${datasetId}/events`);
    const onEvent = (e: MessageEvent): void => {
      try {
        const body = JSON.parse(e.data) as DatasetEventBody["data"];
        if (typeof body?.percent === "number") setProgress(body.percent);
        if (typeof body?.rowsProcessed === "number") setProgress(-1); // indeterminate
      } catch {
        // ignore malformed events
      }
    };
    es.addEventListener("progress", onEvent as EventListener);
    es.addEventListener("done", () => {
      es.close();
      void utils.dataset.get.invalidate({ datasetId });
    });
    es.addEventListener("error", () => {
      // SSE errors on completion; polling via refetchInterval covers the rest.
      es.close();
    });
    return () => es.close();
  }, [dataset, datasetId, isReady, utils.dataset.get]);

  // Load preview rows once ready.
  useEffect(() => {
    if (!isReady) return;
    void fetch(`/api/v1/datasets/${datasetId}/preview?limit=50`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setPreview(j as PreviewData | null));
  }, [datasetId, isReady]);

  const updateType = trpc.dataset.updateColumnType.useMutation({
    onSuccess: () => {
      void utils.dataset.get.invalidate({ datasetId });
      void fetch(`/api/v1/datasets/${datasetId}/preview?limit=50`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setPreview(j as PreviewData | null));
    },
  });

  const statsByCol = useMemo(() => {
    const map = new Map<string, { min?: unknown; max?: unknown; distinct?: number; nullCount?: number }>();
    for (const c of columns) {
      const s = (c.stats ?? {}) as { min?: unknown; max?: unknown; distinct?: number; nullCount?: number };
      map.set(c.name, s);
    }
    return map;
  }, [columns]);

  if (query.isLoading) return <p className="text-zinc-500">Loading dataset…</p>;
  if (query.error) return <p className="text-red-400">{query.error.message}</p>;
  if (!dataset) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{dataset.name}</h1>
        <p className="text-sm text-zinc-500">
          {dataset.originalFilename} · {(dataset.sizeBytes / 1024 / 1024).toFixed(2)} MB
          {dataset.rowCount !== null ? ` · ${dataset.rowCount.toLocaleString()} rows` : ""}
        </p>
      </header>

      {dataset.status !== "ready" && dataset.status !== "failed" && (
        <div className="space-y-2 rounded-xl border border-amber-900 bg-amber-950/30 p-4">
          <p className="text-sm text-amber-200 capitalize">
            Ingestion in progress — {dataset.status}…
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full bg-amber-400 ${progress < 0 ? "animate-pulse w-1/2" : ""}`}
              style={progress >= 0 ? { width: `${Math.min(progress, 100)}%` } : undefined}
            />
          </div>
        </div>
      )}
      {dataset.status === "failed" && (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          Ingestion failed: {dataset.error}
        </div>
      )}

      {isReady && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-zinc-400">Columns and types</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Column</th>
                    <th className="px-3 py-2">Inferred</th>
                    <th className="px-3 py-2">Override</th>
                    <th className="px-3 py-2">Distinct</th>
                    <th className="px-3 py-2">Nulls</th>
                    <th className="px-3 py-2">Min</th>
                    <th className="px-3 py-2">Max</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {columns.map((c) => {
                    const s = statsByCol.get(c.name) ?? {};
                    const effective = c.userType ?? c.inferredType;
                    return (
                      <tr key={c.id}>
                        <td className="px-3 py-2 font-mono text-xs">{c.originalName}</td>
                        <td className="px-3 py-2 text-zinc-400">{c.inferredType}</td>
                        <td className="px-3 py-2">
                          <select
                            value={c.userType ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) return;
                              updateType.mutate({
                                datasetId,
                                columnName: c.name,
                                columnType: v as "number" | "integer" | "text" | "boolean" | "date" | "datetime",
                              });
                            }}
                            className={`rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs ${c.userType ? "border-emerald-700 text-emerald-300" : ""}`}
                          >
                            <option value="">(inferred)</option>
                            {["number", "integer", "text", "boolean", "date", "datetime"].map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <span className="ml-2 text-xs text-zinc-600">{effective}</span>
                        </td>
                        <td className="px-3 py-2 text-zinc-400">{s.distinct ?? "—"}</td>
                        <td className="px-3 py-2 text-zinc-400">{s.nullCount ?? "—"}</td>
                        <td className="px-3 py-2 text-zinc-400">{formatStat(s.min)}</td>
                        <td className="px-3 py-2 text-zinc-400">{formatStat(s.max)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {updateType.error && (
              <p className="text-sm text-red-400">{updateType.error.message}</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium text-zinc-400">Preview (first 50 rows)</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    {(preview?.columns ?? []).map((c) => (
                      <th key={c} className="whitespace-nowrap px-3 py-2 font-mono">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {(preview?.rows ?? []).map((row, i) => (
                    <tr key={i}>
                      {(preview?.columns ?? []).map((c) => (
                        <td key={c} className="max-w-64 truncate whitespace-nowrap px-3 py-1.5">
                          {formatCell(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview === null && <p className="px-3 py-4 text-zinc-500">Loading preview…</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function formatStat(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v).slice(0, 24);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}
