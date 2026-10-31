# Product Requirements Document: Graphite

| | |
|---|---|
| Status | Draft v1 |
| Owner | <your-name> |
| Last updated | <date> |

## 1. Summary

Graphite lets teams turn raw CSV files into interactive dashboards. An AI agent proposes and builds charts; users arrange, swap, and refine them on a collaborative canvas. Graphite also exposes its capabilities through MCP so external AI clients can work on the same dashboards.

## 2. Problem

- Building a dashboard from a CSV takes too many steps: clean, load into a BI tool, pick chart types, configure axes, lay out.
- Non-analysts don't know which charts suit their data.
- AI chart tools usually produce static images or throwaway code, with no versioning, no editing, and no collaboration.
- Teams review dashboards together, but most tools make editing a single-player experience.

## 3. Goals

1. Go from CSV to a first useful dashboard in under 2 minutes.
2. Make every AI-generated chart editable, versioned, and replaceable.
3. Provide smooth, real-time, multi-user editing.
4. Keep tenant data strictly isolated.
5. Make the AI's work transparent: every query and step is visible and auditable.
6. Let external MCP clients operate on Graphite dashboards safely.

## 4. Non-goals (v1)

- Connecting live databases or SaaS data sources (CSV only).
- Pixel-perfect enterprise BI features (row-level data permissions, semantic layers).
- Mobile-native apps (responsive web only).
- Billing and subscription management.
- Real-time collaborative text or CRDT-level merging (stretch goal).

## 5. Personas

| Persona | Description | Key need |
|---|---|---|
| **Maya, Analyst** | Works with CSV exports daily | Fast first draft, then fine control |
| **Sam, Team lead** | Reviews dashboards with the team | Shared live view, comments, sharing |
| **Dev, Power user** | Uses Claude Desktop or Cursor | Drive Graphite from an external AI client |
| **Ola, Org admin** | Manages members and access | Roles, invitations, audit visibility |

## 6. User stories

### Accounts and organizations
- As a user, I can sign up and sign in with email or OAuth.
- As a user, I can create an organization and invite members by email.
- As an owner, I can assign roles (owner, editor, viewer) and remove members.
- As a member, I can belong to multiple organizations and switch between them.

### Projects and datasets
- As an editor, I can create projects inside an organization.
- As an editor, I can upload a CSV and see ingestion progress.
- As an editor, I can preview the data, inferred column types, and basic stats.
- As an editor, I can correct inferred column types.

### Dashboards and charts
- As an editor, I can create dashboards in a project.
- As an editor, I can build a chart manually from a dataset (pick type, axes, aggregation).
- As an editor, I can drag, resize, and swap charts on the canvas.
- As an editor, I can view a chart's version history and revert.
- As a viewer, I can view dashboards and interact with filters but cannot edit.

### AI agent
- As an editor, I can ask the agent to "build a dashboard" and watch it work in a side panel.
- As an editor, I can ask the agent to re-make a specific chart with instructions ("make it a stacked bar, group by region").
- As an editor, I can see the SQL and reasoning behind every generated chart.
- As an editor, I can cancel a running agent job.
- As an org admin, I can see token usage and cost per run.

### Collaboration
- As a member, I can see who else is viewing a dashboard.
- As an editor, I see other editors' cursors and which chart they are moving.
- As an editor, my layout changes appear for others in under 300 ms.
- As an editor, I get a clear message if my change conflicts with a newer one.

### Sharing
- As an editor, I can create a public read-only link to a dashboard and revoke it.
- As an editor, I can export a dashboard as PNG or JSON.

### MCP and integrations
- As a user, I can generate a personal access token on the Integrations page.
- As a user, I can connect Claude Desktop or Cursor using a copy-paste config snippet.
- As a user, I can ask an external AI client to add a chart to my dashboard and see it appear live in the browser.
- As a user, I can see and revoke connected clients and tokens.

## 7. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Email and OAuth authentication | P0 |
| FR-02 | Organizations, members, roles, invitations | P0 |
| FR-03 | Projects scoped to organizations | P0 |
| FR-04 | CSV upload up to 50 MB with async ingestion and progress | P0 |
| FR-05 | Column type inference and manual override | P0 |
| FR-06 | Manual chart builder producing a chart spec | P0 |
| FR-07 | Dashboard canvas with drag, resize, and swap | P0 |
| FR-08 | Chart specs validated by a shared Zod schema | P0 |
| FR-09 | Chart versioning, history, and revert | P0 |
| FR-10 | AI agent generates dashboards from a dataset | P0 |
| FR-11 | AI agent re-makes an individual chart on request | P0 |
| FR-12 | Agent runs execute as background jobs with streaming events | P0 |
| FR-13 | Read-only SQL execution with timeout and row limits | P0 |
| FR-14 | Real-time presence and layout sync | P1 |
| FR-15 | Versioned conflict handling on layout writes | P1 |
| FR-16 | MCP server with personal access token auth | P1 |
| FR-17 | Integrations page (tokens, clients, setup guide) | P1 |
| FR-18 | Run trace viewer (steps, SQL, tokens, cost) | P1 |
| FR-19 | Public share links | P2 |
| FR-20 | PNG and JSON export | P2 |
| FR-21 | OAuth 2.1 for the MCP server | P2 |
| FR-22 | Per-user and per-org rate limiting and usage quotas | P1 |
| FR-23 | Audit log of sensitive actions | P2 |
| FR-24 | Dashboard-level filters (date range, category) | P2 |
| FR-25 | CRDT-based merging with Yjs | Stretch |

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Canvas interactions at 60 fps with up to 20 charts; chart render under 500 ms for 50k rows (aggregated server-side) |
| Latency | Real-time events delivered in under 300 ms (p95) on the same region |
| Ingestion | A 10 MB CSV ingested in under 30 s |
| Security | Strict tenant isolation, read-only query role, input validation everywhere, secrets never logged |
| Reliability | Jobs retry with backoff; no duplicate side effects (idempotent job design) |
| Scalability | API, workers, and data service scale independently on Kubernetes |
| Observability | Traces for every agent run; metrics for queue depth, job latency, token usage |
| Accessibility | Keyboard-operable canvas and WCAG AA contrast |
| Compatibility | Latest two versions of Chrome, Firefox, Safari, Edge |

## 9. Success metrics

- Time from upload to first rendered chart (target: under 2 minutes).
- Percentage of agent-generated chart specs passing validation on the first attempt (target: above 90%).
- Percentage of "re-make" requests accepted without a second re-make.
- Real-time sync latency (p95).
- Agent cost per generated dashboard.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| LLM-written SQL is unsafe or expensive | Read-only role, statement timeout, row limit, allowlisted schema, query validation |
| Invalid chart specs from the model | Zod validation, structured output, retry with error feedback |
| Prompt injection via CSV contents | Treat cell values as data; never place raw cell text in system prompts; cap sample sizes |
| Tenant data leak | Tenant filter in every query, integration tests for isolation, optional Postgres RLS |
| LLM cost overruns | Per-run token budgets, per-org quotas, caching of schema summaries |
| MCP exposes write access to outsiders | Scoped tokens, role checks per tool, rate limits, audit log |
| Scope creep | Phase gates in PHASES.md; manual dashboard works before AI is added |

## 11. Release scope

- **MVP**: FR-01 to FR-13.
- **v1**: adds FR-14 to FR-18 and FR-22.
- **v1.1**: FR-19 to FR-24.
- **Stretch**: FR-25.

## 12. Open questions

- DuckDB for analytics, or Postgres only?
- Better Auth or Auth.js (decide based on organization and OAuth-provider plugin support)?
- Which LLM provider and model for default and fallback?
- Maximum dataset size and row count per plan?