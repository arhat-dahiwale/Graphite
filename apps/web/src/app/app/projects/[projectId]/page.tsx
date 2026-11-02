"use client";

import { use, useRef, useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const utils = trpc.useUtils();
  const datasets = trpc.dataset.list.useQuery({ projectId });
  const dashboards = trpc.dashboard.list.useQuery({ projectId });
  const createDashboard = trpc.dashboard.create.useMutation({
    onSuccess: () => utils.dashboard.list.invalidate({ projectId }),
  });
  const [dashName, setDashName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onUpload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/v1/projects/${projectId}/datasets`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      }
      await utils.dataset.list.invalidate({ projectId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
        <label className="cursor-pointer rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white">
          {uploading ? "Uploading…" : "Upload CSV"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
        </label>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Dashboards</h2>
        <div className="flex gap-2">
          <input
            value={dashName}
            onChange={(e) => setDashName(e.target.value)}
            placeholder="New dashboard name"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            onClick={() => {
              if (dashName.trim()) {
                createDashboard.mutate({ projectId, name: dashName.trim() });
                setDashName("");
              }
            }}
            disabled={!dashName.trim() || createDashboard.isPending}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            Create dashboard
          </button>
        </div>
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
          {(dashboards.data ?? []).map((d) => (
            <li key={d.id} className="px-4 py-3">
              <Link
                href={`/app/projects/${projectId}/dashboards/${d.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {d.name}
              </Link>
              <span className="ml-2 text-xs text-zinc-600">layout v{d.layoutVersion}</span>
            </li>
          ))}
          {dashboards.data?.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">
              No dashboards yet — create one, then add charts to it.
            </li>
          )}
        </ul>
      </section>

      <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
        {(datasets.data ?? []).map((d) => (
          <li key={d.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <Link
                href={`/app/projects/${projectId}/datasets/${d.id}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {d.name}
              </Link>
              <p className="text-sm text-zinc-500">
                {d.originalFilename} · {(d.sizeBytes / 1024 / 1024).toFixed(2)} MB
                {d.rowCount !== null ? ` · ${d.rowCount.toLocaleString()} rows` : ""}
              </p>
            </div>
            <StatusBadge status={d.status} error={d.error} />
          </li>
        ))}
        {datasets.data?.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-zinc-500">
            No datasets yet — upload a CSV to get started.
          </li>
        )}
      </ul>
    </div>
  );
}

function StatusBadge({ status, error }: { status: string; error: string | null }) {
  const cls =
    status === "ready"
      ? "bg-emerald-950 text-emerald-300 border-emerald-900"
      : status === "failed"
        ? "bg-red-950 text-red-300 border-red-900"
        : "bg-amber-950 text-amber-300 border-amber-900";
  return (
    <div className="text-right">
      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs capitalize ${cls}`}>
        {status}
      </span>
      {error && <p className="mt-1 max-w-48 text-xs text-red-400">{error}</p>}
    </div>
  );
}
