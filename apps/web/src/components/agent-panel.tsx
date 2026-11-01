"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

interface RunEventBody {
  type?: string;
  data?: Record<string, unknown>;
}

interface StepView {
  stepIndex: number;
  type: string;
  toolName: string | null;
  output: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  describe_dataset: "Described the dataset",
  run_sql: "Explored with SQL",
  create_chart_spec: "Created a chart",
  update_chart_spec: "Updated a chart",
};

/**
 * Agent side panel: prompt input, live step timeline over SSE, cancel.
 * Runs are labeled with the model so mock runs are never mistaken for
 * real-model output (`mock-scripted`).
 */
export function AgentPanel({
  dashboardId,
  remakeChartId,
  onClearRemake,
}: {
  dashboardId: string;
  remakeChartId?: string | null;
  onClearRemake?: () => void;
}) {
  const utils = trpc.useUtils();
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [model, setModel] = useState<string>("");
  const [steps, setSteps] = useState<StepView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const start = trpc.run.start.useMutation({
    onSuccess: (res) => {
      setRunId(res.runId);
      setStatus("queued");
      setSteps([]);
      setError(null);
    },
    onError: (e) => setError(e.message),
  });
  const cancel = trpc.run.cancel.useMutation();

  // Initial history: previous runs on this dashboard.
  const runList = trpc.run.list.useQuery({ dashboardId });

  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/v1/runs/${runId}/events`);
    const onEvent = (e: MessageEvent): void => {
      try {
        const body = JSON.parse(e.data) as RunEventBody["data"];
        if (!body) return;
        if (body.status) setStatus(String(body.status));
        if (typeof body.toolName === "string") {
          setSteps((prev) => [
            ...prev,
            {
              stepIndex: prev.length,
              type: e.type === "tool_call" ? "tool_call" : "tool_result",
              toolName: body.toolName as string,
              output: body.output ?? body.input ?? null,
            },
          ]);
        } else if (typeof body.delta === "string" && body.delta.length > 0) {
          setSteps((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.type === "text") {
              return [
                ...prev.slice(0, -1),
                { ...last, output: { text: String((last.output as { text?: string })?.text ?? "") + body.delta } },
              ];
            }
            return [...prev, { stepIndex: prev.length, type: "text", toolName: null, output: { text: body.delta } }];
          });
        }
        if (e.type === "error" && typeof body.message === "string") {
          setError(body.message);
        }
      } catch {
        // ignore malformed events
      }
    };
    for (const t of ["status", "text", "tool_call", "tool_result", "chart", "usage", "error", "done"]) {
      es.addEventListener(t, onEvent as EventListener);
    }
    es.onerror = () => {
      es.close();
      // Fall back to polling the run state (SSE ends on completion).
      void utils.run.get.invalidate({ runId });
    };
    return () => es.close();
  }, [runId, utils.run.get]);

  // Poll as a fallback while the run is active.
  const runQuery = trpc.run.get.useQuery(
    { runId: runId ?? "" },
    {
      enabled: !!runId,
      refetchInterval: (q) => {
        const s = q.state.data?.run.status;
        return s === "succeeded" || s === "failed" || s === "cancelled" ? false : 1200;
      },
    },
  );

  // Refresh the dashboard when a run finishes so new charts appear.
  const doneStatus = runQuery.data?.run.status;
  useEffect(() => {
    if (doneStatus === "succeeded" || doneStatus === "failed" || doneStatus === "cancelled") {
      void utils.dashboard.get.invalidate({ dashboardId });
      void utils.chart.versions.invalidate();
    }
  }, [doneStatus, dashboardId, utils.dashboard.get, utils.chart.versions]);

  useEffect(() => {
    if (runQuery.data) {
      setStatus(runQuery.data.run.status);
      setModel(runQuery.data.run.model);
      setSteps(
        runQuery.data.steps.map((s) => ({
          stepIndex: s.stepIndex,
          type: s.type,
          toolName: s.toolName,
          output: s.output,
        })),
      );
    }
  }, [runQuery.data]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [steps.length]);

  const active = status === "queued" || status === "running";

  function submit(): void {
    if (!prompt.trim()) return;
    start.mutate({
      dashboardId,
      kind: remakeChartId ? "remake_chart" : "generate_dashboard",
      prompt: prompt.trim(),
      targetChartId: remakeChartId ?? undefined,
    });
    setPrompt("");
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Agent</h2>
          {model && (
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${
                model === "mock-scripted"
                  ? "border-amber-900 bg-amber-950/60 text-amber-300"
                  : "border-zinc-700 text-zinc-400"
              }`}
              title={
                model === "mock-scripted"
                  ? "Scripted mock model — no LLM API key configured; outputs are deterministic test scripts, not real model output"
                  : undefined
              }
            >
              {model}
            </span>
          )}
        </div>
        {remakeChartId && (
          <p className="mt-1 text-xs text-amber-300">
            Re-make mode: this run will replace the selected chart.{" "}
            <button onClick={onClearRemake} className="underline">
              cancel
            </button>
          </p>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={remakeChartId ? "Describe how to re-make the chart…" : "Ask for a dashboard, e.g. “Build a dashboard from the sales data”"}
          rows={3}
          className="mt-2 w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={submit}
            disabled={active || !prompt.trim()}
            className="flex-1 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {remakeChartId ? "Re-make chart" : "Build dashboard"}
          </button>
          {active && (
            <button
              onClick={() => runId && cancel.mutate({ runId })}
              className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
            >
              Cancel
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      <div ref={timelineRef} className="flex-1 overflow-y-auto p-3 text-sm">
        {steps.length === 0 && !active && (
          <p className="text-xs text-zinc-600">
            {runList.data?.length
              ? "Previous runs are listed below. Start a new run to build charts."
              : "Ask the agent to build a dashboard from your dataset. It will explore the data with SQL and place charts on the canvas."}
          </p>
        )}
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.stepIndex} className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5">
              {s.type === "text" && (
                <p className="text-zinc-300">{String((s.output as { text?: string })?.text ?? "")}</p>
              )}
              {s.type === "tool_call" && (
                <p className="text-zinc-400">
                  <span className="font-mono text-xs text-emerald-400">{s.toolName}</span>{" "}
                  {TOOL_LABELS[s.toolName ?? ""] ?? "Tool call"}…
                </p>
              )}
              {s.type === "tool_result" && (
                <p className="text-xs text-zinc-500">
                  {String((s.output as { error?: string })?.error ?? "done")}
                </p>
              )}
              {s.type === "error" && (
                <p className="text-xs text-red-400">{String((s.output as { message?: string })?.message ?? "error")}</p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-zinc-800 p-3 text-xs text-zinc-500">
        Status: <span className="text-zinc-300">{status}</span>
      </div>
    </aside>
  );
}
