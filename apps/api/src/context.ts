import type { Actor } from "@graphite/core";
import type { Database } from "@graphite/db/client";
import type { Sql } from "postgres";
import type Redis from "ioredis";
import type { IncomingHttpHeaders } from "node:http";
import type { DataClient } from "@graphite/data/client";
import type { GraphiteAuth } from "./auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface AppDeps {
  db: Database;
  sql: Sql;
  redis: Redis;
  /** Better Auth instance; mounts /api/auth/* and resolves sessions. */
  auth?: GraphiteAuth;
  /** gRPC client factory for the data service (chart.data queries). */
  getDataClient: () => DataClient;
  /** Enqueue an agent run for processing by the agent-run worker. */
  enqueueAgentRun: (runId: string) => Promise<void>;
  /** Resolve membership role for a user within an org (repo-backed). */
  resolveMembershipRole: (
    user: SessionUser,
    orgId: string,
  ) => Promise<Actor["role"] | null>;
}

export interface Context {
  requestId: string;
  user: SessionUser | null;
  headers: IncomingHttpHeaders;
  db: Database;
  sql: Sql;
  redis: Redis;
  /** gRPC client for the data service (chart.data queries). */
  getDataClient: () => DataClient;
  /** Actor (membership role) of the session user within an org, or null. */
  actorFor: (orgId: string) => Promise<Actor | null>;
  /** Enqueue an agent run (delegates to the injected queue). */
  enqueueAgentRun: (runId: string) => Promise<void>;
}

/**
 * Build a request context. The session user must already be resolved by the
 * auth middleware; `actorFor` lazily resolves the membership role per org.
 */
export function createContext(
  deps: Pick<AppDeps, "db" | "sql" | "redis" | "getDataClient" | "enqueueAgentRun" | "resolveMembershipRole">,
  opts: { requestId: string; headers: IncomingHttpHeaders; user: SessionUser | null },
): Context {
  const { user } = opts;
  return {
    requestId: opts.requestId,
    headers: opts.headers,
    user,
    db: deps.db,
    sql: deps.sql,
    redis: deps.redis,
    getDataClient: deps.getDataClient,
    enqueueAgentRun: deps.enqueueAgentRun,
    actorFor: async (orgId: string) => {
      if (!user) return null;
      const role = await deps.resolveMembershipRole(user, orgId);
      if (!role) return null;
      return { userId: user.id, orgId, role };
    },
  };
}
