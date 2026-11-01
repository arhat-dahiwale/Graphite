import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbLike } from "../client";
import { dashboards, dashboardCharts, type Dashboard } from "../schema/index";
import { newId } from "@graphite/core";

export interface CreateDashboardInput {
  organizationId: string;
  projectId: string;
  name: string;
  createdBy: string;
}

export async function createDashboard(db: DbLike, input: CreateDashboardInput): Promise<Dashboard> {
  const rows = await db
    .insert(dashboards)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      name: input.name,
      createdBy: input.createdBy,
    })
    .returning();
  const d = rows[0];
  if (!d) throw new Error("Failed to create dashboard");
  return d;
}

export async function getDashboardInOrg(
  db: DbLike,
  organizationId: string,
  dashboardId: string,
): Promise<Dashboard | null> {
  const rows = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Internal lookup without org filter; authorize with the returned org id. */
export async function getDashboardById(db: DbLike, dashboardId: string): Promise<Dashboard | null> {
  const rows = await db.select().from(dashboards).where(eq(dashboards.id, dashboardId)).limit(1);
  return rows[0] ?? null;
}

export async function listDashboardsInProject(db: DbLike, projectId: string): Promise<Dashboard[]> {
  return db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.projectId, projectId), isNull(dashboards.deletedAt)))
    .orderBy(asc(dashboards.createdAt));
}

export async function renameDashboard(
  db: DbLike,
  organizationId: string,
  dashboardId: string,
  name: string,
): Promise<Dashboard | null> {
  const rows = await db
    .update(dashboards)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteDashboard(db: DbLike, organizationId: string, dashboardId: string): Promise<boolean> {
  const rows = await db
    .update(dashboards)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .returning({ id: dashboards.id });
  return rows.length > 0;
}

/**
 * Enable/disable the public share link (Phase 10). Enabling generates a new
 * share id; disabling keeps the id so a re-enable is not a link rotation.
 * Returns the share id (null when never enabled).
 */
export async function setShare(
  db: DbLike,
  organizationId: string,
  dashboardId: string,
  enabled: boolean,
): Promise<{ shareId: string | null; shareEnabled: boolean } | null> {
  const rows = await db
    .update(dashboards)
    .set(
      enabled
        ? { shareEnabled: true, shareId: newId("share"), updatedAt: new Date() }
        : { shareEnabled: false, updatedAt: new Date() },
    )
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .returning({ shareId: dashboards.shareId, shareEnabled: dashboards.shareEnabled });
  const row = rows[0];
  return row ? { shareId: row.shareId, shareEnabled: row.shareEnabled } : null;
}

/** Dashboard-level filters (validated by the caller's Zod schema). */
export async function setFilters(
  db: DbLike,
  organizationId: string,
  dashboardId: string,
  filters: unknown[] | null,
): Promise<Dashboard | null> {
  const rows = await db
    .update(dashboards)
    .set({ filters: filters as never, updatedAt: new Date() })
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export interface LayoutItem {
  chartId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface DashboardLayout {
  layoutVersion: number;
  items: LayoutItem[];
}

export async function getLayout(db: DbLike, dashboardId: string): Promise<DashboardLayout> {
  const dash = await getDashboardById(db, dashboardId);
  const rows = await db
    .select()
    .from(dashboardCharts)
    .where(eq(dashboardCharts.dashboardId, dashboardId))
    .orderBy(asc(dashboardCharts.z));
  return {
    layoutVersion: dash?.layoutVersion ?? 1,
    items: rows.map((r) => ({ chartId: r.chartId, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z })),
  };
}

export type SaveLayoutResult =
  | { ok: true; layoutVersion: number }
  | { ok: false; currentVersion: number; items: LayoutItem[] };

/**
 * Versioned last-write-wins layout save (ARCHITECTURE.md §5.3): the write is
 * accepted only when baseVersion matches the current layout_version; a stale
 * write is rejected with the current layout so the client can reconcile.
 */
export async function saveLayout(
  db: DbLike,
  dashboardId: string,
  baseVersion: number,
  items: LayoutItem[],
): Promise<SaveLayoutResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: dashboards.id, layoutVersion: dashboards.layoutVersion })
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), isNull(dashboards.deletedAt)))
      .for("update")
      .limit(1);
    const dash = rows[0];
    if (!dash) throw new Error("Dashboard not found");
    if (dash.layoutVersion !== baseVersion) {
      const current = await getLayout(tx, dashboardId);
      return { ok: false, currentVersion: dash.layoutVersion, items: current.items };
    }
    await tx.delete(dashboardCharts).where(eq(dashboardCharts.dashboardId, dashboardId));
    if (items.length > 0) {
      await tx.insert(dashboardCharts).values(
        items.map((i) => ({
          dashboardId,
          chartId: i.chartId,
          x: Math.max(0, Math.floor(i.x)),
          y: Math.max(0, Math.floor(i.y)),
          w: Math.max(1, Math.floor(i.w)),
          h: Math.max(1, Math.floor(i.h)),
          z: Math.floor(i.z),
        })),
      );
    }
    const nextVersion = dash.layoutVersion + 1;
    await tx
      .update(dashboards)
      .set({ layoutVersion: nextVersion, updatedAt: new Date() })
      .where(eq(dashboards.id, dashboardId));
    return { ok: true, layoutVersion: nextVersion };
  });
}
