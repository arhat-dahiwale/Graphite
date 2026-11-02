# Graphite architecture (short write-up)

Graphite is a multi-tenant web app where users upload CSVs and an AI agent builds interactive, collaborative dashboards. This document walks through the system in one pass; `ARCHITECTURE.md` holds the decision log and `API.md`/`DATA.md` the interface/schema contracts.

## The shape of the system

Four runtimes plus infrastructure:

- **apps/web** — Next.js (App Router). Server components for shells; client components for the editor. Charts render through one adapter (`specToEChartsOption`) from a shared Zod `ChartSpec`. The agent panel consumes a **custom SSE transport** (`GET /api/v1/runs/:id/events` fed by Redis pub/sub) — the run protocol is step-streaming (text deltas, tool calls/results, usage), not a chat protocol, so the `useChat` hook is not used; the AI SDK runs server-side only.
- **apps/api** — Express 5: tRPC (all browser mutations), REST (uploads, SSE, share/export, integrations, OAuth), Socket.IO with the Redis adapter (presence, cursors, layout sync, live chart events), the **external MCP mount** at `/mcp`, the OAuth 2.1 authorization server, and Prometheus metrics.
- **apps/worker** — BullMQ workers for `ingestion` and `agent-run` on a queue-selective mode (`WORKER_QUEUES`) so Kubernetes can scale each queue independently. The worker also mounts the **internal MCP server** on a localhost-only port and runs a maintenance job (CronJob).
- **services/data** — the only place user-visible SQL executes. Two Postgres pools: metadata as `graphite_app`, all user SQL as `graphite_readonly` (SELECT-only, role-level statement timeout) behind an AST check (single SELECT, table allowlist, row caps).

Infrastructure: Postgres (app tables + per-dataset tables in a `datasets` schema), Redis (queues, pub/sub, presence, rate limits), MinIO/S3 (raw CSVs), and an optional observability stack (OTel collector → Tempo, Prometheus, Grafana).

## The safety boundaries

1. **Tenant isolation**: every query filters by `organization_id` through the repository layer; every entry point (tRPC, REST, WebSocket, MCP) funnels into one `authorize(user, action, resource)` matrix. Cross-tenant access fails closed with NOT_FOUND — asserted by tests for every MCP tool and every Socket.IO event.
2. **SQL safety**: user/LLM SQL never touches the app pool. The chart compiler emits validated, escaped flat SELECTs; the data service re-checks the AST, enforces the allowlist, timeouts, and row caps. Dashboard filters are validated `{field, op, value}` structures merged into the spec and re-validated — never string-built SQL.
3. **Agent/MCP safety**: CSV contents and tool outputs are untrusted data, delimited in prompts, never instructions. Chart specs must pass the shared Zod schema before storage. Tools have per-scope gates (`datasets:read`, `charts:read`, `charts:write`), role checks, audit entries, and rate limits; there are no delete/membership/auth tools.
4. **Secrets**: personal access tokens, OAuth client secrets, codes, and access/refresh tokens are stored only as SHA-256 hashes; the internal agent identity travels in HMAC-signed headers (`INTERNAL_MCP_SECRET`, ≥32 chars, startup fails otherwise).

## MCP: one tool set, two mounts

The same router from `packages/mcp-server` is mounted twice:

- **API `/mcp`** (external): Streamable HTTP, stateless. Auth via personal access token (`gph_live_...`) or OAuth 2.1 access token (`gphat_...`); per-token rate limiting; connected-client tracking from `initialize`.
- **Worker internal** (agent): the orchestrator connects via `@ai-sdk/mcp` with HMAC-signed identity headers carrying `{userId, orgId, runId, dashboardId}`.

Both resolve to the same `ToolContext` (real membership role, org, scopes), so a chart created by Claude Desktop and one created by the agent behave identically: versioned spec, audit entry with `actor_type` `mcp`/`agent`, and a `dash:{id}:events` publish that the Socket.IO relay turns into live updates in open browsers.

## One trace per agent run

With `OTEL_ENABLED=true`, the API request span is injected into the BullMQ job data as W3C `traceparent`; the worker extracts it and opens `agent.run`, with child spans `agent.llm` (the model loop), `agent.tool <name>` per tool call, `grpc.DataService/*` per data-service call, and — inside the data service — `grpc.server DataService/*` and `sql.query` (context travels in gRPC metadata). The trace id lands in `agent_runs.trace_id` and in the in-app run view.

## Operations

- **Local**: `docker compose up -d` (Postgres :5433, Redis :6380, MinIO :9002), `pnpm dev`. The observability profile (`docker-compose.observability.yml`) adds Prometheus/Grafana/Tempo/collector without slowing the base stack.
- **Kubernetes**: manifests in `infra/k8s` — Deployments+Services+HPAs for web/api/data, queue-dedicated workers with KEDA ScaledObjects, probes, ConfigMap/Secret (placeholders), nginx Ingress with WebSocket support, a migration Job, and a maintenance CronJob. Verified on kind end to end, including scaling the ingestion workers under an upload burst.
- **CI**: lint/typecheck/unit+integration tests, kubeconform manifest validation, Playwright e2e, and image builds (push deliberately gated to `main`).
