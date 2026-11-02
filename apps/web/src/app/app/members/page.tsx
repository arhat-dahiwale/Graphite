"use client";

import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { trpc } from "@/lib/trpc";

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
}

export default function MembersPage() {
  const { selectedOrg } = useOrg();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "owner">("viewer");
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const members = trpc.member.list.useQuery(
    { orgId: selectedOrg!.id },
    { enabled: !!selectedOrg },
  );
  const invites = trpc.member.listInvitations.useQuery(
    { orgId: selectedOrg!.id },
    { enabled: !!selectedOrg },
  );
  const invite = trpc.member.invite.useMutation({
    onSuccess: (res) => {
      setInviteLink(res.inviteUrl);
      utils.member.listInvitations.invalidate();
    },
  });
  const updateRole = trpc.member.updateRole.useMutation({
    onSuccess: () => utils.member.list.invalidate(),
  });
  const remove = trpc.member.remove.useMutation({
    onSuccess: () => utils.member.list.invalidate(),
  });
  const revokeInvite = trpc.member.revokeInvitation.useMutation({
    onSuccess: () => utils.member.listInvitations.invalidate(),
  });

  if (!selectedOrg) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">
        Members of {selectedOrg.name}
      </h1>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400">Invite by email</h2>
        <div className="flex flex-wrap gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            type="email"
            className="min-w-64 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm"
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="owner">Owner</option>
          </select>
          <button
            onClick={() => invite.mutate({ orgId: selectedOrg.id, email, role })}
            disabled={!email.includes("@") || invite.isPending}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            Send invite
          </button>
        </div>
        {invite.error && <p className="text-sm text-red-400">{invite.error.message}</p>}
        {inviteLink && (
          <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm">
            <p className="text-emerald-300">
              Email delivery is console-only in this environment. Share this
              link with the invitee:
            </p>
            <code className="mt-1 block break-all font-mono text-xs text-emerald-200">
              {inviteLink}
            </code>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Members</h2>
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
          {(members.data ?? []).map((m: MemberRow) => (
            <li key={m.membershipId} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium">{m.name}</p>
                <p className="text-sm text-zinc-500">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={m.role}
                  onChange={(e) =>
                    updateRole.mutate({
                      orgId: selectedOrg.id,
                      userId: m.userId,
                      role: e.target.value as "owner" | "editor" | "viewer",
                    })
                  }
                  className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm"
                >
                  <option value="owner">owner</option>
                  <option value="editor">editor</option>
                  <option value="viewer">viewer</option>
                </select>
                <button
                  onClick={() => remove.mutate({ orgId: selectedOrg.id, userId: m.userId })}
                  className="text-sm text-zinc-500 underline hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        {updateRole.error && <p className="text-sm text-red-400">{updateRole.error.message}</p>}
        {remove.error && <p className="text-sm text-red-400">{remove.error.message}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-400">Pending invitations</h2>
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900">
          {(invites.data ?? [])
            .filter((i) => i.status === "pending")
            .map((i) => (
              <li key={i.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>
                  {i.email} <span className="text-zinc-500">({i.role})</span>
                </span>
                <button
                  onClick={() =>
                    revokeInvite.mutate({ orgId: selectedOrg.id, invitationId: i.id })
                  }
                  className="text-zinc-500 underline hover:text-red-400"
                >
                  Revoke
                </button>
              </li>
            ))}
          {(invites.data ?? []).filter((i) => i.status === "pending").length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">
              No pending invitations
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
