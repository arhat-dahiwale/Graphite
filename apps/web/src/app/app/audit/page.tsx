"use client";

import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { trpc } from "@/lib/trpc";

const PAGE_SIZE = 25;

/** Owner-only, tenant-scoped, paginated audit log viewer (Phase 10). */
export default function AuditPage() {
  const { selectedOrg, orgs } = useOrg();
  const [page, setPage] = useState(0);
  const canView = orgs.some((o) => o.id === selectedOrg?.id);
  const audit = trpc.audit.list.useQuery(
    { orgId: selectedOrg!.id, page, pageSize: PAGE_SIZE },
    { enabled: !!selectedOrg },
  );

  if (!selectedOrg) return null;
  if (audit.error) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-zinc-400">
          The audit log is only visible to organization owners.
        </p>
      </div>
    );
  }

  const rows = audit.data?.rows ?? [];
  const total = audit.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Audit log{canView ? "" : ""}
      </h1>
      <p className="text-sm text-zinc-400">
        Sensitive actions across {selectedOrg.name} — chart changes, tokens,
        members, and agent activity. Newest first.
      </p>
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-800 text-xs uppercase text-zinc-500">
            <tr>
              <th scope="col" className="px-4 py-2">When</th>
              <th scope="col" className="px-4 py-2">Actor</th>
              <th scope="col" className="px-4 py-2">Action</th>
              <th scope="col" className="px-4 py-2">Resource</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-4 py-2 text-zinc-400">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                    {r.actorType}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-zinc-200">{r.action}</td>
                <td className="px-4 py-2 text-xs text-zinc-500">
                  {r.resourceType}:{r.resourceId.slice(0, 16)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-zinc-500">
                  No audit entries yet — actions like chart edits and token
                  creation will appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-zinc-400">
        <span>
          Page {page + 1} of {pages} · {total} entries
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-md border border-zinc-700 px-3 py-1 disabled:opacity-40"
            aria-label="Previous page"
          >
            Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="rounded-md border border-zinc-700 px-3 py-1 disabled:opacity-40"
            aria-label="Next page"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
