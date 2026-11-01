import { Server as SocketServer, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type Redis from "ioredis";
import { z } from "zod";
import { childLogger, dashboardEventsChannel } from "@graphite/core";
import { parseAllowedOrigins } from "@graphite/core/config";
import type { Database } from "@graphite/db/client";
import { dashboards } from "@graphite/db/schema";
import { eq } from "drizzle-orm";
import { getMembership } from "@graphite/db/repo/members";
import { saveLayout } from "@graphite/db/repo/dashboards";
import type { GraphiteAuth } from "./auth.js";
import type { Server as HttpServer } from "node:http";

const log = childLogger({ component: "collab" });

const joinInput = z.object({ dashboardId: z.string().min(1) });
const presenceInput = z.object({
  dashboardId: z.string().min(1),
  selectedChartId: z.string().max(64).optional(),
});
const cursorInput = z.object({ dashboardId: z.string().min(1), x: z.number(), y: z.number() });
const dragInput = z.object({
  dashboardId: z.string().min(1),
  chartId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  state: z.enum(["start", "move", "end"]),
});
const layoutSaveInput = z.object({
  dashboardId: z.string().min(1),
  baseVersion: z.number().int().min(1),
  items: z
    .array(
      z.object({
        chartId: z.string().min(1),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(24),
        z: z.number().int().min(0),
      }),
    )
    .max(100),
});

export interface CollabOptions {
  httpServer: HttpServer;
  redis: Redis;
  redisSub: Redis;
  db: Database;
  auth?: GraphiteAuth;
  /** Explicit browser origins; defaults to CORS_ORIGINS when omitted. */
  allowedOrigins?: string[];
}

interface CollabSocket extends Socket {
  data: {
    user?: { id: string; email: string; name: string };
    joinedDashboards: Set<string>;
    lastCursorAt: number;
  };
}

/**
 * Socket.IO collaboration server (namespace /collab).
 * - Redis adapter so users on different API instances share rooms.
 * - dashboard:join requires membership (viewer+); viewers may listen but their
 *   layout:save is denied.
 * - Presence lives in a Redis hash with a TTL; cursors and drag indicators are
 *   ephemeral relays (throttled).
 * - Dashboard events published by MCP tools / agent runs / tRPC arrive via the
 *   `dash:{id}:events` Redis channel and are relayed to the room.
 */
export function setupCollab(opts: CollabOptions): SocketServer {
  const allowedOrigins = opts.allowedOrigins ?? parseAllowedOrigins(process.env.CORS_ORIGINS);
  const io = new SocketServer(opts.httpServer, {
    path: "/socket.io",
    // Same explicit origin list as Express CORS (CORS_ORIGINS when not passed).
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    // cors only withholds headers; this actually aborts handshakes from
    // disallowed origins. Missing Origin (non-browser clients, e.g. tests
    // and internal monitors) is allowed — session auth still applies.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback("origin not allowed", false);
    },
  });
  io.adapter(createAdapter(opts.redis, opts.redisSub));
  void opts.redisSub;

  const ns = io.of("/collab");

  ns.use(async (socket: CollabSocket, next) => {
    try {
      const user = opts.auth ? await opts.auth.resolveSession(socket.handshake.headers) : null;
      socket.data.user = user ?? undefined;
      socket.data.joinedDashboards = new Set();
      socket.data.lastCursorAt = 0;
      if (!user) {
        next(new Error("UNAUTHORIZED"));
        return;
      }
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  async function membershipRole(dashboardId: string, userId: string): Promise<string | null> {
    const rows = await opts.db.select().from(dashboards).where(eq(dashboards.id, dashboardId)).limit(1);
    const dash = rows[0];
    if (!dash || dash.deletedAt) return null;
    return getMembership(opts.db, dash.organizationId, userId);
  }

  const presenceKey = (dashboardId: string): string => `presence:${dashboardId}`;

  ns.on("connection", (socket: CollabSocket) => {
    const user = socket.data.user;

    socket.on("dashboard:join", async (raw, ack?: (res: unknown) => void) => {
      try {
        const parsed = joinInput.safeParse(raw);
        if (!parsed.success || !user) {
          ack?.({ ok: false, error: "BAD_REQUEST" });
          return;
        }
        const role = await membershipRole(parsed.data.dashboardId, user.id);
        if (!role) {
          ack?.({ ok: false, error: "NOT_FOUND" });
          return;
        }
        const room = `dashboard:${parsed.data.dashboardId}`;
        await socket.join(room);
        socket.data.joinedDashboards.add(parsed.data.dashboardId);
        // Presence: hash field per socket with user info + TTL refresh.
        await opts.redis.hset(
          presenceKey(parsed.data.dashboardId),
          socket.id,
          JSON.stringify({ userId: user.id, name: user.name, color: colorFor(socket.id) }),
        );
        await opts.redis.expire(presenceKey(parsed.data.dashboardId), 60);
        const members = await opts.redis.hvals(presenceKey(parsed.data.dashboardId));
        ns.to(room).emit("presence:state", {
          users: members
            .map((m) => JSON.parse(m) as { userId: string; name: string; color: string })
            .filter((u) => u.userId === user.id || true),
        });
        ack?.({ ok: true, role });
      } catch (e) {
        log.error({ err: e }, "dashboard:join failed");
        ack?.({ ok: false, error: "INTERNAL" });
      }
    });

    socket.on("dashboard:leave", async (raw) => {
      const parsed = joinInput.safeParse(raw);
      if (!parsed.success) return;
      await socket.leave(`dashboard:${parsed.data.dashboardId}`);
      socket.data.joinedDashboards.delete(parsed.data.dashboardId);
      await opts.redis.hdel(presenceKey(parsed.data.dashboardId), socket.id);
      ns.to(`dashboard:${parsed.data.dashboardId}`).emit("presence:state", {
        users: await presenceUsers(opts.redis, parsed.data.dashboardId),
      });
    });

    socket.on("presence:update", async (raw) => {
      const parsed = presenceInput.safeParse(raw);
      if (!parsed.success || !user) return;
      // Only sockets that joined (membership-checked) may write presence.
      if (!socket.data.joinedDashboards.has(parsed.data.dashboardId)) return;
      await opts.redis.hset(
        presenceKey(parsed.data.dashboardId),
        socket.id,
        JSON.stringify({ userId: user.id, name: user.name, color: colorFor(socket.id), selectedChartId: parsed.data.selectedChartId }),
      );
      await opts.redis.expire(presenceKey(parsed.data.dashboardId), 60);
      socket
        .to(`dashboard:${parsed.data.dashboardId}`)
        .emit("presence:state", { users: await presenceUsers(opts.redis, parsed.data.dashboardId) });
    });

    socket.on("cursor:move", (raw) => {
      const parsed = cursorInput.safeParse(raw);
      if (!parsed.success || !user) return;
      // Relays only for dashboards this socket joined (join checks membership),
      // so cross-tenant payloads can never reach another org's room.
      if (!socket.data.joinedDashboards.has(parsed.data.dashboardId)) return;
      // Throttle to ~30 Hz per connection.
      const now = Date.now();
      if (now - socket.data.lastCursorAt < 33) return;
      socket.data.lastCursorAt = now;
      socket
        .to(`dashboard:${parsed.data.dashboardId}`)
        .emit("cursor:update", { userId: user.id, name: user.name, color: colorFor(socket.id), x: parsed.data.x, y: parsed.data.y });
    });

    socket.on("chart:drag", (raw) => {
      const parsed = dragInput.safeParse(raw);
      if (!parsed.success || !user) return;
      if (!socket.data.joinedDashboards.has(parsed.data.dashboardId)) return;
      socket.to(`dashboard:${parsed.data.dashboardId}`).emit("chart:drag", {
        userId: user.id,
        name: user.name,
        color: colorFor(socket.id),
        chartId: parsed.data.chartId,
        x: parsed.data.x,
        y: parsed.data.y,
        state: parsed.data.state,
      });
    });

    socket.on("layout:save", async (raw, ack?: (res: unknown) => void) => {
      try {
        const parsed = layoutSaveInput.safeParse(raw);
        if (!parsed.success || !user) {
          ack?.({ ok: false, error: "BAD_REQUEST" });
          return;
        }
        const role = await membershipRole(parsed.data.dashboardId, user.id);
        if (!role) {
          ack?.({ ok: false, error: "NOT_FOUND" });
          return;
        }
        if (role === "viewer") {
          ack?.({ ok: false, error: "FORBIDDEN" });
          return;
        }
        const result = await saveLayout(
          opts.db,
          parsed.data.dashboardId,
          parsed.data.baseVersion,
          parsed.data.items,
        );
        if (result.ok) {
          ns.to(`dashboard:${parsed.data.dashboardId}`).emit("layout:updated", {
            layoutVersion: result.layoutVersion,
            items: parsed.data.items,
            by: user.id,
          });
          ack?.({ ok: true, layoutVersion: result.layoutVersion });
        } else {
          // Only the stale writer learns about the conflict.
          socket.emit("layout:conflict", {
            currentVersion: result.currentVersion,
            items: result.items,
          });
          ack?.({ ok: false, error: "CONFLICT", currentVersion: result.currentVersion });
        }
      } catch (e) {
        log.error({ err: e }, "layout:save failed");
        ack?.({ ok: false, error: "INTERNAL" });
      }
    });

    socket.on("disconnecting", async () => {
      for (const dashboardId of socket.data.joinedDashboards) {
        await opts.redis.hdel(presenceKey(dashboardId), socket.id);
        socket.to(`dashboard:${dashboardId}`).emit("presence:state", {
          users: await presenceUsers(opts.redis, dashboardId),
        });
      }
    });
  });

  // Relay dashboard events published by MCP tools / agent runs / tRPC to rooms.
  const relay = opts.redis.duplicate();
  void (async () => {
    await relay.psubscribe(`dash:*:events`);
    relay.on("pmessage", (_pattern, channel, message) => {
      const dashboardId = channel.replace("dash:", "").replace(":events", "");
      try {
        const parsed = JSON.parse(message) as { type: string; data?: Record<string, unknown> };
        ns.to(`dashboard:${dashboardId}`).emit(parsed.type, parsed.data ?? {});
      } catch {
        // ignore malformed events
      }
    });
  })();

  return io;
}

async function presenceUsers(redis: Redis, dashboardId: string): Promise<Array<{ userId: string; name: string; color: string; selectedChartId?: string }>> {
  const members = await redis.hvals(`presence:${dashboardId}`);
  return members.map((m) => JSON.parse(m) as { userId: string; name: string; color: string; selectedChartId?: string });
}

const COLORS = ["#38bdf8", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa", "#fb7185"];
function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length] as string;
}

export { dashboardEventsChannel };
