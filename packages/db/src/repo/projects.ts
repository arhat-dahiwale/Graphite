import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbLike } from "../client.js";
import { projects, type Project } from "../schema/index.js";

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  description?: string | null;
  createdBy: string;
}

export async function createProject(db: DbLike, input: CreateProjectInput): Promise<Project> {
  const rows = await db
    .insert(projects)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  const project = rows[0];
  if (!project) throw new Error("Failed to create project");
  return project;
}

/** Tenant-scoped: only returns the project when it belongs to the org. */
export async function getProjectInOrg(
  db: DbLike,
  organizationId: string,
  projectId: string,
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listProjectsInOrg(
  db: DbLike,
  organizationId: string,
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
    .orderBy(asc(projects.createdAt));
}

export async function updateProject(
  db: DbLike,
  organizationId: string,
  projectId: string,
  patch: { name?: string; description?: string | null },
): Promise<Project | null> {
  const rows = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteProject(
  db: DbLike,
  organizationId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .update(projects)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.deletedAt),
      ),
    )
    .returning({ id: projects.id });
  return rows.length > 0;
}

/**
 * Internal lookup by id without an org filter. Callers must run the result
 * through requireAuthorized with the project's organizationId before acting.
 */
export async function getProjectById(db: DbLike, projectId: string): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0] ?? null;
}
