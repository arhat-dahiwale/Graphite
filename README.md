# Graphite

> Turn a CSV into an interactive, collaborative dashboard. Let an AI agent build it, then drag, swap, and refine it with your team.

Graphite is a multi-tenant analytics platform. Upload a CSV, ask the agent for charts, and arrange them on a live canvas that your whole team can edit together. Every chart is a versioned, declarative spec, so nothing is ever lost. Graphite's tools are also exposed over MCP, so external AI clients (Claude Desktop, Cursor, anything MCP) can work on the same dashboards.

## Features

- **AI dashboard generation**: an LLM agent explores your dataset with tools (schema, read-only SQL) and produces validated chart specs.
- **Interactive canvas**: drag, resize, and swap charts with smooth animations.
- **Re-make any chart**: ask the agent to redo a chart; every change is a new version with undo and history.
- **Real-time collaboration**: live presence, cursors, and layout sync across team members (Socket.IO + Redis adapter).
- **Organizations and projects**: roles (owner, editor, viewer), invitations, and strict tenant isolation.
- **MCP integration**: Graphite is an MCP server. Personal access tokens *and* OAuth 2.1 (PKCE) for external clients.
- **Public share links**: read-only, revocable, data-minimized payloads.
- **Exports**: dashboard JSON and per-chart PNG (ECharts image export).
- **Dashboard filters**: validated date-range/category filters applied through the safe query compiler.
- **Observability**: OpenTelemetry traces (one trace per agent run), Prometheus metrics, Grafana dashboards, Tempo; in-app run/trace viewer with simulated-cost labeling.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS, Framer Motion, react-grid-layout v2, Apache ECharts, TanStack Query, Zod, Socket.IO client. The agent panel streams run steps over a **custom SSE transport** — the Vercel AI SDK runs server-side only (no `useChat`; the run protocol is step-streaming, not a chat protocol) |
| Backend | Node.js, Express 5, tRPC v11, REST, Socket.IO (+ Redis adapter), BullMQ |
| AI | Vercel AI SDK core (`streamText`, tools) + MCP TypeScript SDK via `@ai-sdk/mcp`; LLM provider pluggable (`mock-scripted` deterministic model by default, Anthropic optional) |
| Data | PostgreSQL 17 + Drizzle ORM, Redis 7, S3-compatible storage (MinIO locally) |
| Auth | Better Auth (email+password; optional Google/GitHub OAuth sign-in) |
| MCP auth | Personal access tokens (hashed) and a minimal OAuth 2.1 authorization server (PKCE S256, dynamic client registration, refresh rotation, revocation) |
| Infra | Docker Compose, Kubernetes manifests (kind-tested), GitHub Actions |
| Observability | OpenTelemetry, Prometheus, Grafana, Tempo (OTel collector) |
| Testing | Vitest, Playwright (e2e + axe accessibility), kubeconform |
| Tooling | Turborepo, pnpm |

## Architecture

```
 Claude Desktop / Cursor ──┐                    (browser)
                           ▼                        ▼
                    API /mcp (PAT or OAuth)   Next.js frontend
                           │                        │ tRPC + SSE + Socket.IO
 Graphite agent ──► MCP ───┤                        ▼
 (worker, signed identity) │                 Express API (:4000)
                           │                  │           │
                           ▼                  │           │
              Data service (gRPC) ◄───────────┘           │
              read-only Postgres role                     ▼
                           │                        Redis (queues, pub/sub,
                           ▼                        presence, rate limits)
                    Postgres (datasets schema)      BullMQ workers
```

- **Two MCP mounts, one tool set**: the same router in `packages/mcp-server` is mounted twice — in the **API** at `/mcp` (external clients; personal access tokens or OAuth 2.1 access tokens) and in the **worker** on a localhost-only port (the agent's orchestrator, authenticated with HMAC-signed identity headers). Both converge on the same `ToolContext`, so authorization, audit logging, and dashboard events are identical.
- See [docs/architecture.md](./docs/architecture.md) for the full write-up and [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions.

Tools exposed: `list_projects`, `list_datasets`, `describe_dataset`, `sample_rows`, `run_sql`, `list_dashboards`, `list_charts`, `create_chart_spec`, `update_chart_spec`, `add_chart_to_dashboard` — scoped by `datasets:read`, `charts:read`, `charts:write`. See [API.md](./API.md).

## Monorepo layout

```
apps/web              Next.js frontend (incl. Playwright e2e + axe a11y tests)
apps/api              Express: tRPC, REST, Socket.IO, external MCP mount, OAuth AS
apps/worker           BullMQ workers (ingestion, agent runs), internal MCP mount, maintenance
services/data         gRPC query service (read-only role, AST check, row/timeout caps)
packages/chart-spec   Zod schemas for chart specs (the AI safety contract)
packages/core         ids, errors, authorize() matrix, env parsing, event channels
packages/db           Drizzle schema and migrations
packages/mcp-server   MCP tools, token/OAuth services, internal auth
packages/storage      S3/MinIO helpers
packages/telemetry    OpenTelemetry + Prometheus metrics
infra/                Compose files, k8s manifests, observability provisioning, load test
docs/                 Architecture write-up
```

## Getting started

### Prerequisites
- Node.js 20+, pnpm 12+
- Docker and Docker Compose

### Base stack (no LLM key needed)

The agent runs on the deterministic `mock-scripted` model by default, so the whole product works without any API key.

```bash
git clone <your-fork-url> graphite && cd graphite
pnpm install
cp .env.example .env        # defaults work for local dev
docker compose up -d        # postgres :5433, redis :6380, minio :9002
pnpm db:setup               # roles, schemas, test DB, migrations
pnpm dev                    # web :3000, api :4000, worker :4001, data :50051/50052
```

Open http://localhost:3000, sign up, create an org → project, upload a CSV, create a dashboard, and click **Build dashboard** — the mock agent produces three labeled agent charts.

### Observability profile (optional)

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

Then set `OTEL_ENABLED=true` (default in `.env.example`) and restart `pnpm dev`. Grafana runs at http://localhost:3001 (anonymous admin in dev), Prometheus at :9132, Tempo API at :3218. Four dashboards are provisioned (API health, queues, agent runs, simulated cost); every agent run stores its trace id in `agent_runs.trace_id`, visible in the agent panel and fetchable from Tempo.

### Local service ports

| Service | Port | Notes |
|---|---|---|
| web | 3000 | Next.js |
| api | 4000 | Express (tRPC, REST, MCP at /mcp, OAuth, WebSockets) |
| worker health/metrics | 4001 | BullMQ worker health endpoint |
| postgres | 5433 | Mapped from 5432 to avoid host conflicts |
| redis | 6380 | Mapped from 6379 to avoid host conflicts |
| minio | 9002 (API), 9003 (console) | Mapped from 9000/9001 |
| data gRPC | 50051 | gRPC query service |
| data health | 50052 | HTTP health + metrics |
| grafana | 3001 | Observability profile only |
| prometheus | 9132 | Observability profile only (host side) |
| tempo | 3218 | Observability profile only (host side) |
| otel collector | 4317/4318 | OTLP gRPC/HTTP |

### AI provider

`LLM_PROVIDER=mock` (the default when no key is set) runs the deterministic scripted model; runs are labeled `mock-scripted` in the UI and in `agent_runs.model`, and cost figures for them are simulated (shown as $0.00 with an explanatory tooltip). Set `LLM_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY` for a real model.

### Connecting external MCP clients

Create a token on the Integrations page (shown once, stored hashed), or register an OAuth client dynamically (`POST /oauth/register`) and run the PKCE flow. Config snippet for Claude Desktop / Cursor:

```json
{
  "mcpServers": {
    "graphite": {
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer gph_live_xxxxxxxxxxxxxxxx" }
    }
  }
}
```

### Docker images

Each app has a multi-stage, non-root Dockerfile (pinned `node:22.20.0-alpine3.22`):

```bash
docker build -f apps/web/Dockerfile -t graphite-web . 
docker build -f apps/api/Dockerfile -t graphite-api .
docker build -f apps/worker/Dockerfile -t graphite-worker .
docker build -f services/data/Dockerfile -t graphite-data .
```

### Kubernetes

Manifests live in `infra/k8s/` (validated with kubeconform; the full stack was verified on kind): Deployments + Services for web/api/data, queue-dedicated worker Deployments with KEDA ScaledObjects, CPU HPAs, probes on `/readyz`+`/healthz`, ConfigMap + placeholder Secret, nginx Ingress (WebSocket + sticky), migration Job, and a maintenance CronJob.

```bash
kind create cluster --name graphite
kind load docker-image graphite-web graphite-api graphite-worker graphite-data --name graphite
kubectl apply -f infra/k8s/
```

See `infra/k8s/` file headers for details. KEDA is required for the ScaledObjects (queue-depth scaling); without it, scale worker deployments manually.

### Load test

```bash
k6 run -e BASE_URL=http://localhost:4000 infra/loadtest/k6-load-test.js
```

See [infra/loadtest/README.md](./infra/loadtest/README.md).

## Documentation

| File | Purpose |
|---|---|
| [PRD.md](./PRD.md) | Product requirements |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and decisions |
| [docs/architecture.md](./docs/architecture.md) | Short architecture write-up |
| [PHASES.md](./PHASES.md) | Build plan and progress |
| [DATA.md](./DATA.md) | Database schema |
| [API.md](./API.md) | REST, tRPC, WebSocket, gRPC, and MCP interfaces |
| [AGENTS.md](./AGENTS.md) | Instructions for AI coding agents |
| [LOGS.md](./LOGS.md) | Agent work log |

## Known limitations (honest)

- **MinIO image**: `bitnamilegacy/minio` is an **unmaintained, local-development-only** image, used because the official MinIO images were unavailable from Docker Hub in this environment. Do not use it in production; swap in MinIO's official image or S3.
- **Mock model**: without an LLM key the agent runs the deterministic `mock-scripted` model. Real-model behavior (live LLM verification of the two Phase 4/5 criteria) is deferred to a human with an API key.
- **Claude Desktop**: the external MCP path was verified with a scripted MCP client (protocol-level), not with a real desktop client.
- **KEDA**: ScaledObjects are defined and validate, but automatic queue-depth scaling was not verifiable here (operator install blocked); workers scale via `kubectl scale` (verified) or CPU HPAs.
- **HPA CPU metrics** need metrics-server in the cluster (not installed on the local kind cluster).
- **Dashboards filters** are validated structures applied through the compiler — but the UI is a simple field/op/value bar, not a full date-picker.
- **Loki/log aggregation** is not set up (logs are structured JSON on stdout).
- OAuth sign-in (Google/GitHub) is wired but unverified (no provider keys in this environment).

## Status

Built through Phase 10. See [PHASES.md](./PHASES.md) for per-task progress and [LOGS.md](./LOGS.md) for the build log.

## License

MIT (update as needed)
