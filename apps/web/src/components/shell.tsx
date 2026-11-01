"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { OrgProvider, useOrg } from "./org-context";

/**
 * App shell: session guard, sidebar with org switcher, main content.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const orgsQuery = trpc.org.list.useQuery(undefined, {
    retry: false,
    enabled: !!session,
  });

  useEffect(() => {
    if (!isPending && !session) router.replace("/signin");
  }, [isPending, session, router]);

  useEffect(() => {
    if (orgsQuery.error) router.replace("/signin");
  }, [orgsQuery.error, router]);

  if (isPending || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-zinc-500">
        Loading…
      </div>
    );
  }

  const orgs = orgsQuery.data ?? [];

  return (
    <OrgProvider orgs={orgs}>
      <div className="flex min-h-screen">
        <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-4">
          <Link href="/" className="mb-6 text-lg font-semibold tracking-tight">
            Graphite
          </Link>
          <OrgSwitcher orgs={orgs} />
          <nav className="mt-4 space-y-1 text-sm">
            <Link
              href="/app"
              className="block rounded-md px-2 py-1.5 text-zinc-300 hover:bg-zinc-900"
            >
              Projects
            </Link>
            <Link
              href="/app/members"
              className="block rounded-md px-2 py-1.5 text-zinc-300 hover:bg-zinc-900"
            >
              Members &amp; invites
            </Link>
            <Link
              href="/app/integrations"
              className="block rounded-md px-2 py-1.5 text-zinc-300 hover:bg-zinc-900"
            >
              Integrations (MCP)
            </Link>
          </nav>
          <div className="mt-auto text-xs text-zinc-500">
            {session.user.email}
            <button
              onClick={() =>
                authClient.signOut().then(() => router.replace("/signin"))
              }
              className="mt-1 block text-zinc-400 underline hover:text-zinc-200"
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="flex-1 overflow-x-hidden p-6">{children}</main>
      </div>
    </OrgProvider>
  );
}

function OrgSwitcher({ orgs }: { orgs: Array<{ id: string; name: string }> }) {
  const { selectedOrg, selectOrg } = useOrg();
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-zinc-500">Organization</p>
      {orgs.length === 0 ? (
        <p className="text-sm text-zinc-500">No organizations yet</p>
      ) : (
        <select
          value={selectedOrg?.id ?? ""}
          onChange={(e) => selectOrg(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
