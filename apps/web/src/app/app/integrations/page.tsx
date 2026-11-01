"use client";

import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { trpc } from "@/lib/trpc";

const SCOPES = ["datasets:read", "charts:read", "charts:write"] as const;

const SCOPE_HELP: Record<(typeof SCOPES)[number], string> = {
  "datasets:read": "Explore projects, datasets, rows, run read-only SQL",
  "charts:read": "List dashboards and charts",
  "charts:write": "Create charts, new versions, place charts on dashboards",
};

interface CreatedToken {
  id: string;
  token: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
}

export default function IntegrationsPage() {
  const { selectedOrg } = useOrg();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Array<(typeof SCOPES)[number]>>(["datasets:read", "charts:read"]);
  const [expiresInDays, setExpiresInDays] = useState<string>("90");
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens = trpc.integration.listTokens.useQuery(
    { orgId: selectedOrg!.id },
    { enabled: !!selectedOrg },
  );
  const clients = trpc.integration.listClients.useQuery(
    { orgId: selectedOrg!.id },
    { enabled: !!selectedOrg },
  );

  const createToken = trpc.integration.createToken.useMutation({
    onSuccess: (res) => {
      setCreated(res as CreatedToken);
      setName("");
      utils.integration.listTokens.invalidate();
    },
  });
  const revokeToken = trpc.integration.revokeToken.useMutation({
    onSuccess: () => {
      utils.integration.listTokens.invalidate();
      utils.integration.listClients.invalidate();
    },
  });

  if (!selectedOrg) return null;

  const mcpUrl = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        graphite: {
          url: mcpUrl,
          headers: { Authorization: `Bearer ${created?.token ?? "gph_live_xxxxxxxxxxxxxxxx"}` },
        },
      },
    },
    null,
    2,
  );

  function toggleScope(scope: (typeof SCOPES)[number]): void {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Integrations (MCP)</h1>
      <p className="text-sm text-zinc-400">
        Connect external AI clients such as Claude Desktop or Cursor to Graphite.
        Create a personal access token, paste the config snippet into the client,
        and the client can explore your data and edit your dashboards within its
        scopes. Tokens are stored hashed and shown once.
      </p>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Create a token</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. Claude Desktop)"
            aria-label="Token name"
            className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <select
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            aria-label="Token expiry"
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm"
          >
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">365 days</option>
            <option value="">Never expires</option>
          </select>
          <button
            onClick={() =>
              createToken.mutate({
                orgId: selectedOrg.id,
                name,
                scopes,
                expiresInDays: expiresInDays === "" ? null : Number(expiresInDays),
              })
            }
            disabled={!name || scopes.length === 0 || createToken.isPending}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            Create token
          </button>
        </div>
        <div className="space-y-1">
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={() => toggleScope(s)}
                className="accent-zinc-100"
              />
              <code className="text-xs">{s}</code>
              <span className="text-zinc-500">{SCOPE_HELP[s]}</span>
            </label>
          ))}
        </div>
        {createToken.error && <p className="text-sm text-red-400">{createToken.error.message}</p>}
      </section>

      {created && (
        <section className="space-y-3 rounded-xl border border-emerald-900 bg-emerald-950/30 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-emerald-300">
              Token created — copy it now, it is shown only once
            </h2>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(created.token).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="rounded-md border border-emerald-800 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-900"
            >
              {copied ? "Copied!" : "Copy token"}
            </button>
          </div>
          <code className="block break-all rounded-md bg-zinc-950 p-3 font-mono text-xs text-emerald-200">
            {created.token}
          </code>
          <h3 className="text-sm font-medium text-zinc-300">Client config snippet</h3>
          <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
            {snippet}
          </pre>
          <p className="text-xs text-zinc-500">
            Paste this into your MCP client configuration (format varies by
            client and version — see its docs). The client needs at least one
            read scope; write scopes are only needed to create or change charts.
          </p>
          <button
            onClick={() => setCreated(null)}
            className="text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            Dismiss
          </button>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Your tokens</h2>
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
          {(tokens.data ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <p className="font-medium">
                  {t.name}{" "}
                  {t.revokedAt && (
                    <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                      revoked
                    </span>
                  )}
                </p>
                <p className="text-xs text-zinc-500">
                  <code>{t.prefix}…</code> · {t.scopes.join(", ")} ·{" "}
                  {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
                  {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              {!t.revokedAt && (
                <button
                  onClick={() => revokeToken.mutate({ orgId: selectedOrg.id, tokenId: t.id })}
                  className="text-zinc-500 underline hover:text-red-400"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
          {(tokens.data ?? []).length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">
              No tokens yet — create one above to connect an MCP client.
            </li>
          )}
        </ul>
        {revokeToken.error && <p className="text-sm text-red-400">{revokeToken.error.message}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Connected clients</h2>
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
          {(clients.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <p className="font-medium">{c.clientName}</p>
                <p className="text-xs text-zinc-500">
                  {c.clientVersion ? `v${c.clientVersion} · ` : ""}
                  first seen {new Date(c.firstSeenAt).toLocaleDateString()} · last seen{" "}
                  {new Date(c.lastSeenAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
          {(clients.data ?? []).length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">
              No clients have connected yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
