# Build Phases: Graphite

Each phase has a goal, deliverables, and an exit criterion. Do not start a phase until the previous phase's exit criteria are all checked. At every phase end, the app must be demoable.

## How to use this file (for agents)

- Change `- [ ]` to `- [x]` only when the task is fully done: code written, tests passing, docs updated.
- Do not tick a box for partial work. If a task is half done, leave it unchecked and note the state in `LOGS.md`.
- Never delete or reword tasks. If a task needs to change, add a new line below it and explain in `LOGS.md`.
- Tick a phase's "Exit" items last, after verifying them.
- Tick the phase in the Progress tracker at the bottom only when every box in that phase is checked.

---

## Phase 0: Foundation
**Goal:** a reproducible monorepo and local environment.

- [x] Turborepo + pnpm workspace with apps and packages from the README layout
- [x] TypeScript, ESLint, Prettier, shared tsconfig
- [x] Docker Compose: Postgres, Redis, MinIO
- [x] Drizzle set up with a migration pipeline
- [x] GitHub Actions: lint, typecheck, test
- [x] `.env.example` and base README

**Exit criteria**
- [x] `pnpm install && docker compose up -d && pnpm dev` starts all apps
- [x] Each app exposes a hello-world endpoint

---

## Phase 1: Auth, organizations, projects
**Goal:** multi-tenant skeleton.

- [x] Auth with email and OAuth sign-in, plus sessions
- [x] Organizations, members, roles (owner, editor, viewer)
- [x] Email invitations and accept flow
- [x] Projects CRUD
- [x] Central `authorize()` helper
- [x] Repository layer with tenant filtering
- [x] App shell UI: sidebar, org switcher, project list

**Exit criteria**
- [x] Two users in different orgs cannot see each other's data (integration test passes)
- [x] Role checks verified for owner, editor, and viewer

---

## Phase 2: CSV ingestion
**Goal:** upload a CSV and query it.

- [x] Upload endpoint with streaming to MinIO
- [x] BullMQ ingestion worker with idempotent job IDs
- [x] Column type inference and bulk load into `datasets.ds_<id>`
- [x] Ingestion progress events over SSE
- [x] Dataset page: progress, preview table, column types, stats
- [x] Manual column type override
- [x] gRPC data service with `DescribeDataset`, `SampleRows`, `ColumnStats`, `RunQuery`
- [x] `graphite_readonly` role, schema separation, statement timeout
- [x] SQL AST check (single SELECT only), row limit, table allowlist

**Exit criteria**
- [x] A 10 MB CSV is uploaded and previewed in under 30 seconds
- [x] Tests confirm unsafe SQL is rejected (writes, multiple statements, other schemas)

---

## Phase 3: Chart spec and manual dashboard
**Goal:** a full dashboard experience with no AI.

- [x] `packages/chart-spec` Zod schemas
- [x] `specToEChartsOption` adapter
- [x] Structured query compiler (spec query to safe SQL)
- [x] Manual chart builder UI
- [x] Dashboards, charts, and chart versions in the database
- [x] Chart version history and revert
- [x] Canvas with drag, resize, and swap
- [x] Framer Motion layout transitions
- [x] Layout persistence with `layout_version`

**Exit criteria**
- [x] A user can build, arrange, and edit a multi-chart dashboard manually
- [x] Reverting a chart creates a new version and renders correctly
- [x] The product is demoable without any AI features

---

## Phase 4: The agent
**Goal:** the AI builds and re-makes charts.

- [x] Vercel AI SDK integration with provider config
- [x] Tools: `describe_dataset`, `run_sql`, `create_chart_spec`, `update_chart_spec`
- [x] System prompts and prompt-injection safeguards for CSV content
- [x] `agent-run` BullMQ queue with concurrency limit
- [x] Streaming run events via Redis pub/sub and SSE
- [x] Agent side panel with `useChat`, step timeline, and cancel button
- [x] "Re-make this chart" action on each chart card
- [x] Spec validation with retry on invalid output
- [x] Per-run token budget
- [x] `agent_runs`, `agent_steps`, `conversations`, and `messages` persistence

**Exit criteria**
- [x] "Build a dashboard" on a fresh dataset produces at least 3 valid charts
- [ ] Verified with a live LLM (deferred: no API key during overnight build)
- [x] Re-make creates a new chart version
- [ ] Verified with a live LLM (deferred: no API key during overnight build)
- [x] Cancelling a run stops it between steps

---

## Phase 5: MCP server (internal)
**Goal:** tools live behind MCP.

- [x] `packages/mcp-server` with Phase 4 tools
- [x] Additional tools: `list_projects`, `list_datasets`, `list_dashboards`, `list_charts`, `sample_rows`, `add_chart_to_dashboard`
- [x] Orchestrator switched to the AI SDK MCP client
- [x] Identity propagation into every tool call
- [x] Authorization and tenant checks inside each tool
- [x] Audit log entries for write tools

**Exit criteria**
- [x] Agent behavior is unchanged from Phase 4
- [ ] Verified with a live LLM (deferred: no API key during overnight build)
- [x] All agent tool calls pass through MCP

---

## Phase 6: Real-time collaboration
**Goal:** multi-user live editing.

- [ ] Socket.IO server with Redis adapter
- [ ] Room join with membership check
- [ ] Presence (who is viewing)
- [ ] Live cursors
- [ ] "Who is moving which chart" indicators
- [ ] Versioned layout writes with `baseVersion`
- [ ] Conflict feedback and reconciliation in the UI
- [ ] Live chart version events, including agent-created charts

**Exit criteria**
- [ ] Two browsers connected to different API instances stay in sync
- [ ] Conflict path is covered by a test
- [ ] Viewers cannot save layout changes

---

## Phase 7: MCP server (external)
**Goal:** Claude Desktop and Cursor can use Graphite.

- [ ] Streamable HTTP endpoint at `/mcp`
- [ ] Personal access tokens: hashed, scoped, revocable, shown once
- [ ] Token auth middleware resolving user, org, and scopes
- [ ] Integrations page: create token, config snippet, connected clients
- [ ] Connected client tracking
- [ ] Audit log entries for external tool calls
- [ ] Events published so open browsers update live
- [ ] Demo GIF of a chart created from an external client

**Exit criteria**
- [ ] A chart created from Claude Desktop appears live in an open dashboard
- [ ] A revoked token is rejected immediately
- [ ] A token without `charts:write` cannot call write tools

---

## Phase 8: Observability and hardening
**Goal:** the system is measurable and safe.

- [ ] OpenTelemetry in api, worker, and data service
- [ ] Trace context propagated through BullMQ jobs and gRPC metadata
- [ ] Prometheus metrics: queue depth, job latency, run duration, tokens, cost, WebSocket connections
- [ ] Grafana dashboards for API health, queues, agent runs, and cost
- [ ] Tempo for traces
- [ ] In-app trace viewer with cost display
- [ ] Rate limiting per user, per token, and per org
- [ ] Org quotas for agent runs and tokens (`usage_daily`)
- [ ] Security tests: tenant isolation
- [ ] Security tests: SQL injection
- [ ] Security tests: prompt injection fixtures

**Exit criteria**
- [ ] One agent run is fully traceable end to end in Grafana
- [ ] Quota and rate limits are enforced and tested

---

## Phase 9: Kubernetes and CI/CD
**Goal:** deployable and scalable.

- [ ] Dockerfile for each app and service
- [ ] Kubernetes manifests or Helm chart
- [ ] Readiness and liveness probes (`/readyz`, `/healthz`)
- [ ] ConfigMaps, Secrets, and Ingress (WebSocket-compatible)
- [ ] HPA on CPU for web, api, and data service
- [ ] Queue-depth scaling for workers
- [ ] CronJob for maintenance
- [ ] CI builds and pushes images
- [ ] Playwright end-to-end tests in CI
- [ ] Load test script

**Exit criteria**
- [ ] The full stack runs on kind or minikube
- [ ] Workers scale independently under load

---

## Phase 10: Polish and extras
**Goal:** portfolio-ready.

- [ ] Public share links with revoke
- [ ] PNG and JSON export
- [ ] Dashboard-level filters (date range, category)
- [ ] OAuth 2.1 for MCP (discovery metadata, PKCE, token refresh)
- [ ] Audit log viewer
- [ ] Empty states and onboarding
- [ ] Keyboard shortcuts and accessibility pass
- [ ] README diagrams and architecture write-up
- [ ] Demo video
- [ ] Stretch: Yjs-based merging
- [ ] Stretch: DuckDB analytics engine
- [ ] Stretch: scheduled dataset refresh

**Exit criteria**
- [ ] README, docs, and demo are complete
- [ ] A new developer can run the project from the README alone

---

## Progress tracker

Tick a phase only when every box inside it is checked.

- [x] Phase 0: Foundation
- [x] Phase 1: Auth, orgs, projects
- [x] Phase 2: CSV ingestion
- [x] Phase 3: Manual dashboard
- [ ] Phase 4: Agent (done except live-LLM verification)
- [ ] Phase 5: MCP (internal) (done except live-LLM verification)
- [ ] Phase 6: Collaboration
- [ ] Phase 7: MCP (external)
- [ ] Phase 8: Observability
- [ ] Phase 9: Kubernetes and CI/CD
- [ ] Phase 10: Polish