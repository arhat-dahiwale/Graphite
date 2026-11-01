import { notFound } from "next/navigation";
import { specToEChartsOption, type ChartSpec } from "@graphite/chart-spec";
import { PublicChart } from "./public-chart";

/**
 * Public read-only dashboard view (Phase 10 share links). Server component:
 * fetches the minimal public payload from the API. No authentication, no
 * organization/user data in the payload.
 */
export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  const res = await fetch(`${apiUrl}/api/v1/public/dashboards/${shareId}`, {
    cache: "no-store",
  });
  if (!res.ok) notFound();
  const payload = (await res.json()) as {
    dashboard: { name: string; filters: Array<{ field: string; op: string; value: unknown }> };
    charts: Array<{
      chartId: string;
      title: string;
      position: { x: number; y: number; w: number; h: number };
      spec: ChartSpec;
      data: { columns: string[]; rows: unknown[][] } | { error: string };
    }>;
  };

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{payload.dashboard.name}</h1>
        <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-500">
          read-only shared view
        </span>
      </header>
      {payload.dashboard.filters.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
          {payload.dashboard.filters.map((f, i) => (
            <span key={i} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5">
              <code>
                {f.field} {f.op} {String(f.value)}
              </code>
            </span>
          ))}
        </div>
      )}
      <div className="grid auto-rows-[minmax(180px,auto)] grid-cols-1 gap-3 md:grid-cols-3">
        {payload.charts.map((c) => (
          <div
            key={c.chartId}
            className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
            style={{
              gridColumn: `span ${Math.min(c.position.w, 3)}`,
              gridRow: `span ${Math.max(1, Math.round(c.position.h / 4))}`,
            }}
          >
            <div className="border-b border-zinc-800 px-3 py-2 text-sm font-medium">{c.title}</div>
            <div className="min-h-[180px] flex-1">
              <PublicChart
                spec={c.spec}
                option={specToEChartsOption(
                  c.spec,
                  "columns" in c.data
                    ? {
                        columns: c.data.columns,
                        rows: c.data.rows.map((r) =>
                          Object.fromEntries((c.data as { columns: string[] }).columns.map((col, i) => [col, r[i]])),
                        ),
                      }
                    : { columns: [], rows: [] },
                )}
              />
            </div>
          </div>
        ))}
        {payload.charts.length === 0 && (
          <p className="col-span-3 py-12 text-center text-sm text-zinc-500">
            This dashboard has no charts yet.
          </p>
        )}
      </div>
    </main>
  );
}
