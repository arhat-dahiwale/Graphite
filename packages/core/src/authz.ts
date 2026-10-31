/**
 * Central authorization. Roles and the capability matrix live here so that
 * tRPC, REST, WebSocket, and MCP all enforce identical rules.
 *
 * Role ladder per DATA.md:
 *  owner  - everything, including members, org tokens, deletion
 *  editor - create/edit projects, datasets, dashboards, charts; run the agent
 *  viewer - read dashboards and charts; no edits or agent runs
 */
export type Role = "owner" | "editor" | "viewer";

export const ROLES: readonly Role[] = ["owner", "editor", "viewer"] as const;

export function roleAtLeast(role: Role, min: Role): boolean {
  const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
  return rank[role] >= rank[min];
}

/** Actor is the resolved identity of the caller within one organization. */
export interface Actor {
  userId: string;
  orgId: string;
  role: Role;
}

export type ResourceType =
  | "organization"
  | "project"
  | "dataset"
  | "dashboard"
  | "chart"
  | "run"
  | "token";

/**
 * All actions that require authorization. Every entry point (tRPC, REST,
 * WebSocket, MCP) must call `authorize()` before touching tenant data.
 */
export type Action =
  | "org:read"
  | "org:manage" // rename, delete org, manage members & invitations
  | "project:read"
  | "project:write"
  | "dataset:read"
  | "dataset:write" // upload, rename, override types, delete
  | "dashboard:read"
  | "dashboard:write" // create, layout, share settings
  | "chart:read"
  | "chart:write" // create, new versions, revert, place on dashboard
  | "agent:run" // start agent runs
  | "token:read"
  | "token:write"; // create/revoke own tokens

const REQUIRED_ROLE: Record<Action, Role> = {
  "org:read": "viewer",
  "org:manage": "owner",
  "project:read": "viewer",
  "project:write": "editor",
  "dataset:read": "viewer",
  "dataset:write": "editor",
  "dashboard:read": "viewer",
  "dashboard:write": "editor",
  "chart:read": "viewer",
  "chart:write": "editor",
  "agent:run": "editor",
  "token:read": "viewer",
  "token:write": "editor",
};

export interface AuthorizeResource {
  type: ResourceType;
  /** Organization the resource belongs to; the actor must be a member. */
  organizationId: string;
  /** Optional extra check, e.g. resource owner for token:write. */
  ownerId?: string;
  userId?: string;
}

/**
 * Throws nothing; returns true when allowed. Callers convert a `false`
 * result into a NOT_FOUND/FORBIDDEN error appropriate to the transport.
 * NOT_FOUND is preferred when the caller has no membership at all (do not
 * leak resource existence across tenants).
 */
export function authorize(actor: Actor, action: Action, resource: AuthorizeResource): boolean {
  if (actor.orgId !== resource.organizationId) return false;
  const min = REQUIRED_ROLE[action];
  if (!roleAtLeast(actor.role, min)) return false;
  // Personal tokens: editors may manage only their own tokens.
  if (action === "token:write" && resource.ownerId !== undefined) {
    return resource.ownerId === actor.userId || actor.role === "owner";
  }
  return true;
}

export function assertAuthorized(
  actor: Actor,
  action: Action,
  resource: AuthorizeResource,
): void {
  if (!authorize(actor, action, resource)) {
    throw new Error(
      `Authorization failed: ${action} on ${resource.type} for role ${actor.role}`,
    );
  }
}
