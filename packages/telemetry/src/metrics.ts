import client from "prom-client";

/**
 * Prometheus metrics (Phase 8). One registry per process; api, worker, and
 * the data service each expose it on their own /metrics endpoint.
 */

export const registry = new client.Registry();
registry.setDefaultLabels({} as Record<string, string>);

client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "graphite_http_request_duration_seconds",
  help: "HTTP request duration by route and method",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const agentRunDuration = new client.Histogram({
  name: "graphite_agent_run_duration_seconds",
  help: "Agent run wall-clock duration by status and model",
  labelNames: ["status", "model"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const agentTokens = new client.Counter({
  name: "graphite_agent_tokens_total",
  help: "LLM tokens processed by direction and model",
  labelNames: ["direction", "model"] as const,
  registers: [registry],
});

export const agentRunTotal = new client.Counter({
  name: "graphite_agent_runs_total",
  help: "Agent runs by status and model",
  labelNames: ["status", "model"] as const,
  registers: [registry],
});

export const agentCostUsd = new client.Counter({
  name: "graphite_agent_cost_usd_total",
  help: "Simulated LLM cost by model (mock-scripted runs report 0; not real spend)",
  labelNames: ["model"] as const,
  registers: [registry],
});

export const jobDuration = new client.Histogram({
  name: "graphite_job_duration_seconds",
  help: "BullMQ job processing duration by queue",
  labelNames: ["queue"] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [registry],
});

export const wsConnections = new client.Gauge({
  name: "graphite_websocket_connections",
  help: "Currently connected Socket.IO clients",
  registers: [registry],
});

/** Serve /metrics payloads (text/plain exposition format). */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
