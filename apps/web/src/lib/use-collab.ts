"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export interface PresenceUser {
  userId: string;
  name: string;
  color: string;
  selectedChartId?: string;
}

export interface CursorUpdate {
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

export interface DragUpdate {
  userId: string;
  name: string;
  color: string;
  chartId: string;
  x: number;
  y: number;
  state: "start" | "move" | "end";
}

export interface RemoteLayout {
  layoutVersion: number;
  items: Array<{ chartId: string; x: number; y: number; w: number; h: number; z: number }>;
  by: string;
}

/**
 * Collaboration client: joins the dashboard room, relays presence + cursors,
 * and listens for remote layout writes and chart version events.
 * The API_URL default keeps the socket on the API origin (Next cannot proxy
 * WebSockets in dev).
 */
export function useCollab(dashboardId: string, enabled = true): {
  connected: boolean;
  selfId: string | null;
  presence: PresenceUser[];
  cursors: Record<string, CursorUpdate>;
  dragging: Record<string, DragUpdate>;
  remoteLayout: RemoteLayout | null;
  chartVersionEvent: { chartId: string; version: number } | null;
  /** A chart was added to (or removed from) the dashboard; refetch it. */
  chartAddedEvent: { chartId: string; at: number } | null;
  sendCursor: (x: number, y: number) => void;
  sendDrag: (chartId: string, x: number, y: number, state: "start" | "move" | "end") => void;
} {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [cursors, setCursors] = useState<Record<string, CursorUpdate>>({});
  const [dragging, setDragging] = useState<Record<string, DragUpdate>>({});
  const [remoteLayout, setRemoteLayout] = useState<RemoteLayout | null>(null);
  const [chartVersionEvent, setChartVersionEvent] = useState<{ chartId: string; version: number } | null>(null);
  const [chartAddedEvent, setChartAddedEvent] = useState<{ chartId: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled || !dashboardId) return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    const socket = io(`${apiUrl}/collab`, {
      transports: ["polling", "websocket"],
      withCredentials: true,
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setSelfId(socket.id ?? null);
      socket.emit("dashboard:join", { dashboardId });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("presence:state", (data: { users?: PresenceUser[] }) => {
      const self = socket.id;
      setPresence((data.users ?? []).filter((u) => u.userId !== self));
    });
    socket.on("cursor:update", (data: CursorUpdate & { userId: string }) => {
      setCursors((prev) => ({ ...prev, [data.userId]: data }));
    });
    socket.on("chart:drag", (data: DragUpdate) => {
      setDragging((prev) => {
        const next = { ...prev };
        if (data.state === "end") delete next[data.userId];
        else next[data.userId] = data;
        return next;
      });
    });
    socket.on("layout:updated", (data: RemoteLayout) => setRemoteLayout(data));
    socket.on(
      "chart:version-created",
      (data: { chartId?: string; version?: number }) => {
        if (data.chartId) {
          setChartVersionEvent({ chartId: data.chartId, version: data.version ?? 0 });
        }
      },
    );
    socket.on("chart:added", (data: { chartId?: string }) => {
      if (data.chartId) {
        setChartAddedEvent({ chartId: data.chartId, at: Date.now() });
      }
    });

    const interval = setInterval(() => {
      if (socket.connected) {
        socket.emit("presence:update", { dashboardId });
      }
    }, 20_000);

    return () => {
      clearInterval(interval);
      socket.emit("dashboard:leave", { dashboardId });
      socket.close();
      socketRef.current = null;
    };
  }, [dashboardId, enabled]);

  function sendCursor(x: number, y: number): void {
    socketRef.current?.emit("cursor:move", { dashboardId, x, y });
  }

  function sendDrag(chartId: string, x: number, y: number, state: "start" | "move" | "end"): void {
    socketRef.current?.emit("chart:drag", { dashboardId, chartId, x, y, state });
  }

  return { connected, selfId, presence, cursors, dragging, remoteLayout, chartVersionEvent, chartAddedEvent, sendCursor, sendDrag };
}
