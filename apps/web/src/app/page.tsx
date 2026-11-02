const apiUrl = process.env.API_URL ?? "http://localhost:4000";

async function getApiHealth(): Promise<string> {
  try {
    const res = await fetch(`${apiUrl}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return `api responded ${res.status}`;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok" ? "api: ok" : "api: unknown status";
  } catch {
    return "api: unreachable";
  }
}

export default async function Home() {
  const health = await getApiHealth();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Graphite</h1>
      <p className="max-w-prose text-center text-zinc-400">
        Turn a CSV into an interactive, collaborative dashboard. Let the AI
        analyst build it, then drag, swap, and refine it with your team.
      </p>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 font-mono text-sm text-zinc-300">
        {health}
      </div>
    </main>
  );
}
