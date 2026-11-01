"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const accept = trpc.member.acceptInvite.useMutation();

  if (isPending) return <div className="p-8 text-zinc-500">Loading…</div>;

  if (!session) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold">You were invited to join Graphite</h1>
        <p className="text-sm text-zinc-400">
          Sign in or create an account with the invited email address first.
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => router.push(`/signin?next=/invite/${token}`)}
            className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
          >
            Sign in
          </button>
          <button
            onClick={() => router.push(`/signup?next=/invite/${token}`)}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-900"
          >
            Create account
          </button>
        </div>
      </main>
    );
  }

  if (accept.isSuccess) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold">You are in! 🎉</h1>
        <p className="text-sm text-zinc-400">Role: {accept.data.role}</p>
        <button
          onClick={() => router.push("/app")}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          Go to your projects
        </button>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-xl font-semibold">Accept invitation</h1>
      {accept.error && <p className="text-sm text-red-400">{accept.error.message}</p>}
      <button
        onClick={() => accept.mutate({ token })}
        disabled={accept.isPending}
        className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
      >
        {accept.isPending ? "Accepting…" : "Accept invite"}
      </button>
    </main>
  );
}
