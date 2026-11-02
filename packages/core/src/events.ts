/**
 * Redis pub/sub event channel names and shared payload types.
 *
 * Channels (see DATA.md §10):
 *  - run:{runId}:events        agent run lifecycle events (SSE source)
 *  - dataset:{datasetId}:events  ingestion progress events (SSE source)
 *  - dash:{dashboardId}:events dashboard events (Socket.IO relay source)
 *
 * Publish happens from API, workers, and MCP tools; the API instance holding
 * the subscriber (SSE or Socket.IO) relays to its local connections. This is
 * what makes multi-instance deployments work.
 */

export interface RunEvent {
  type:
    | "status"
    | "text"
    | "tool_call"
    | "tool_result"
    | "chart"
    | "usage"
    | "done"
    | "error";
  runId: string;
  seq: number;
  at: string; // ISO timestamp
  data: Record<string, unknown>;
}

export interface DatasetEvent {
  type: "progress" | "done" | "error";
  datasetId: string;
  data: Record<string, unknown>;
}

export interface DashboardEvent {
  type:
    | "chart:version-created"
    | "chart:added"
    | "chart:removed"
    | "layout:updated"
    | "run:status";
  dashboardId: string;
  data: Record<string, unknown>;
}

export const runEventsChannel = (runId: string) => `run:${runId}:events`;
export const datasetEventsChannel = (datasetId: string) => `dataset:${datasetId}:events`;
export const dashboardEventsChannel = (dashboardId: string) =>
  `dash:${dashboardId}:events`;
