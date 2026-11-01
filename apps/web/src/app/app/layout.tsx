"use client";

import { useState } from "react";
import { Shell } from "@/components/shell";
import { OrgProvider, useOrg } from "@/components/org-context";
import { TrpcProvider } from "@/lib/providers";
import { trpc } from "@/lib/trpc";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <TrpcProvider>
      <Shell>
        <OrgGuard>{children}</OrgGuard>
      </Shell>
    </TrpcProvider>
  );
}

/** Blocks content until an organization is selected (or offers creating one). */
function OrgGuard({ children }: { children: React.ReactNode }) {
  const { selectedOrg, orgs } = useOrg();
  const utils = trpc.useUtils();
  const orgCreate = trpc.org.create.useMutation({
    onSuccess: () => utils.org.list.invalidate(),
  });
  const [name, setName] = useState("");

  if (!selectedOrg) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="text-lg font-semibold">
          {orgs.length === 0 ? "Create your first organization" : "Select an organization"}
        </h2>
        <p className="text-sm text-zinc-400">
          Projects, datasets, and dashboards live inside an organization.
        </p>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Organization name"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <button
            onClick={() => {
              if (name.trim().length > 0) {
                orgCreate.mutate({ name: name.trim() });
                setName("");
              }
            }}
            disabled={orgCreate.isPending}
            className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            Create
          </button>
        </div>
        {orgCreate.error && (
          <p className="text-sm text-red-400">{orgCreate.error.message}</p>
        )}
      </div>
    );
  }
  return <>{children}</>;
}
