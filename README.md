# Graphite

> Turn a CSV into an interactive, collaborative dashboard. Let an AI analyst build it, then drag, swap, and refine it with your team.

Graphite is a multi-tenant analytics platform. Upload a CSV, ask the agent for charts, and arrange them on a live canvas that your whole team can edit together. Don't like a chart? Ask the agent to remake it. Every chart is a versioned, declarative spec, so nothing is ever lost.

## Features

- **AI dashboard generation**: an LLM agent explores your dataset with tools (schema, read-only SQL) and produces validated chart specs.
- **Interactive canvas**: drag, resize, and swap charts with smooth animations.
- **Re-make any chart**: ask the agent to redo a chart; every change is a new version with undo and history.
- **Real-time collaboration**: live presence, cursors, and layout sync across team members.
- **Organizations and projects**: roles (owner, editor, viewer), invitations, and strict tenant isolation.
- **MCP integration**: Graphite is an MCP server. Use Claude Desktop, Cursor, or any MCP client to create and edit charts in your real dashboards.
- **Observability**: traces, metrics, and token/cost tracking for every agent run.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui, Framer Motion, dnd-kit / react-grid-layout, Apache ECharts, TanStack Query, Zustand, Zod, Socket.IO client, Vercel AI SDK (`useChat`) |
| Backend | Node.js, Express, tRPC, REST, gRPC, Socket.IO (+ Redis adapter), BullMQ |
| AI | Vercel AI SDK core (`streamText`, `streamObject`, tools), LLM API (Claude or similar), MCP TypeScript SDK |
| Data | PostgreSQL, Drizzle ORM, Redis, S3-compatible storage (MinIO), DuckDB (optional) |
| Auth | Better Auth (or Auth.js) with organizations and roles |
| Infra | Docker, Docker Compose, Kubernetes (kind/minikube), HPA, GitHub Actions |
| Observability | OpenTelemetry, Prometheus, Grafana, Tempo (Loki optional) |
| Testing | Vitest, Playwright |
| Tooling | Turborepo, pnpm |

## How Graphite uses MCP

Graphite's tools are defined once in `packages/mcp-server` and consumed two ways:

1. **Internal client**: Graphite's own agent connects to the MCP server through the AI SDK's MCP client.
2. **External server**: Claude Desktop, Cursor, or any MCP client connects over Streamable HTTP with a personal access token (OAuth 2.1 planned) and works on the user's real dashboards.

```
 Claude Desktop / Cursor ──┐
                           ▼
 Graphite agent ──► MCP server ──► Data service (gRPC) ──► Postgres (read-only role)
                           │
                           └──► Redis pub/sub ──► Browser updates live
```

Tools exposed: `list_projects`, `list_datasets`, `describe_dataset`, `run_sql`, `create_chart_spec`, `update_chart_spec`, `list_charts`, `add_chart_to_dashboard`. See [API.md](./API.md).

## Monorepo layout

```
apps/web              Next.js frontend
apps/api              Express: tRPC, REST, WebSockets, agent orchestrator
apps/worker           BullMQ workers (ingestion, agent runs, refresh)
services/data         gRPC query service
packages/chart-spec   Zod schemas for chart specs
packages/db           Drizzle schema and migrations
packages/mcp-server   MCP tools and resources
packages/ui           Shared UI components
infra/                Dockerfiles, Compose, k8s manifests, Grafana dashboards
docs/                 Diagrams and screenshots
```

## Getting started

### Prerequisites
- Node.js 20+, pnpm 9+
- Docker and Docker Compose
- An LLM API key

### Setup
```bash
git clone https://github.com/<your-username>/graphite.git
cd graphite
pnpm install
cp .env.example .env        # fill in values
docker compose up -d        # postgres, redis, minio, observability stack
pnpm db:setup               # roles, schemas, test DB, migrations
pnpm db:migrate             # apply pending migrations
pnpm dev                    # starts web, api, worker, data service
```

Open http://localhost:3000.

### Local service ports
| Service | Port | Notes |
|---|---|---|
| web | 3000 | Next.js |
| api | 4000 | Express (tRPC, REST, WebSockets) |
| worker health | 4001 | BullMQ worker health endpoint |
| postgres | 5433 | Mapped from 5432 to avoid host conflicts |
| redis | 6380 | Mapped from 6379 to avoid host conflicts |
| minio | 9002 (API), 9003 (console) | Mapped from 9000/9001 |
| data gRPC | 50051 | gRPC query service |
| data health | 50052 | HTTP health endpoint |

The nonstandard host ports (5433, 6380, 9002) dodge conflicts with services commonly installed on developer machines. All values are set in `.env`.

### AI provider
`LLM_PROVIDER=mock` (the default when no key is set) runs a deterministic scripted model so the full product works end to end without an LLM API key. Set `LLM_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY` for a real model. Mock runs are labeled `mock-scripted` in the UI and in `agent_runs.model`.

### Useful scripts
| Command | Description |
|---|---|
| `pnpm dev` | Run all apps in watch mode |
| `pnpm build` | Build all packages and apps |
| `pnpm lint` / `pnpm typecheck` | Static checks |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations |

## Documentation

| File | Purpose |
|---|---|
| [PRD.md](./PRD.md) | Product requirements |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design and decisions |
| [PHASES.md](./PHASES.md) | Build plan |
| [DATA.md](./DATA.md) | Database schema |
| [API.md](./API.md) | REST, tRPC, WebSocket, gRPC, and MCP interfaces |
| [AGENTS.md](./AGENTS.md) | Instructions for AI coding agents |
| [LOGS.md](./LOGS.md) | Agent work log |

## Status

Under active development. See [PHASES.md](./PHASES.md) for progress.

## License

MIT (update as needed)