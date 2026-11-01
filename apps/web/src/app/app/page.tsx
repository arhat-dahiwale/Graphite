"use client";

import { useState } from "react";
import Link from "next/link";
import { useOrg } from "@/components/org-context";
import { trpc } from "@/lib/trpc";

export default function ProjectsPage() {
  const { selectedOrg } = useOrg();
  const utils = trpc.useUtils();
  const projectsQuery = trpc.project.list.useQuery(
    { orgId: selectedOrg!.id },
    { enabled: !!selectedOrg },
  );
  const projectCreate = trpc.project.create.useMutation({
    onSuccess: () => utils.project.list.invalidate(),
  });
  const projectDelete = trpc.project.delete.useMutation({
    onSuccess: () => utils.project.list.invalidate(),
  });
  const [name, setName] = useState("");

  if (!selectedOrg) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Projects in {selectedOrg.name}
        </h1>
      </header>

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              projectCreate.mutate({ orgId: selectedOrg.id, name: name.trim() });
              setName("");
            }
          }}
        />
        <button
          onClick={() => {
            if (name.trim()) {
              projectCreate.mutate({ orgId: selectedOrg.id, name: name.trim() });
              setName("");
            }
          }}
          disabled={projectCreate.isPending || !name.trim()}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          Create project
        </button>
      </div>
      {projectCreate.error && (
        <p className="text-sm text-red-400">{projectCreate.error.message}</p>
      )}

      <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
        {(projectsQuery.data ?? []).map((p) => (
          <li key={p.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="font-medium">{p.name}</p>
              {p.description && (
                <p className="text-sm text-zinc-500">{p.description}</p>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-zinc-600">
                {new Date(p.createdAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => {
                  if (confirm(`Delete project "${p.name}"?`)) {
                    projectDelete.mutate({ orgId: selectedOrg.id, projectId: p.id });
                  }
                }}
                className="text-zinc-500 underline hover:text-red-400"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {projectsQuery.data?.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-zinc-500">
            No projects yet — create one above, then upload CSVs into it.
          </li>
        )}
      </ul>

      <p className="text-sm text-zinc-500">
        Datasets and dashboards arrive in the next phases; the project is their
        container. Manage your team under{" "}
        <Link href="/app/members" className="underline">
          Members &amp; invites
        </Link>
        .
      </p>
    </div>
  );
}
