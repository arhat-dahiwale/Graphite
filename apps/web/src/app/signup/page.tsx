"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await authClient.signUp.email({ name, email, password });
    setPending(false);
    if (res.error) {
      setError(res.error.message ?? "Sign-up failed");
      return;
    }
    router.push("/app");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6"
      >
        <h1 className="text-xl font-semibold">Create your account</h1>
        <div className="space-y-2">
          <label className="block text-sm text-zinc-400" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            autoComplete="name"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm text-zinc-400" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            autoComplete="email"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-sm text-zinc-400" htmlFor="password">
            Password (8+ characters)
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            autoComplete="new-password"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {pending ? "Creating account…" : "Sign up"}
        </button>
        <p className="text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link href="/signin" className="text-zinc-300 underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
