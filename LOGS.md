# LOGS.md

Append-only log of agent work. Every agent appends one entry at the end of each run. Do not edit or delete earlier entries. Newest entries go at the bottom.

## Entry format

```
### <YYYY-MM-DD HH:MM> | <agent name/model> | Phase <n>
**Task:** one line describing what was asked
**Summary:** what was done, 2 to 5 bullets
**Files changed:** key paths
**Docs updated:** DATA.md / API.md / ARCHITECTURE.md / none
**Tests:** what was run and the result
**Decisions:** non-obvious choices and why (or "none")
**Follow-ups:** open issues, TODOs, blockers (or "none")
```

## Rules

- Be factual: say what was actually done and what was not.
- Record failures and unfinished work honestly.
- Never include secrets or raw user data.
- Keep each entry under about 20 lines.

---

## Log

### 2026-11-01 00:00 | project-setup | Phase 0
**Task:** Create initial project documentation
**Summary:**
- Added README.md, PRD.md, ARCHITECTURE.md, PHASES.md, AGENTS.md, LOGS.md, DATA.md, API.md
**Files changed:** root-level markdown files
**Docs updated:** all (initial versions)
**Tests:** n/a
**Decisions:** project name locked as Graphite; ECharts chosen as the chart renderer
**Follow-ups:** start Phase 0 (monorepo scaffold)

### 2026-11-01 05:10 | GLM-5.3-Flash (overnight run) | Phase 0
**Task:** Complete Phase 0 foundation (full DATA.md schema included)
**Summary:**
- Monorepo scaffolded: turbo + pnpm workspaces, shared tsconfig, ESLint (flat, typescript-eslint), Prettier, CI workflow
- apps/api (Express 5 + tRPC v11, /healthz /readyz /trpc hello), apps/worker (health :4001), apps/web (Next 16 + Tailwind 4, fetches api health), services/data (gRPC skeleton :50051 + health :50052)
- packages/core (ids, logger, typed AppError, authorize() matrix, Redis event channels, env parsing), packages/db (full DATA.md schema: 22 tables, Drizzle, idempotent db:setup creating roles/schemas/graphite_test + migrations on main and test DBs)
- Docker services verified: Postgres 17 (:5433), Redis 7 (:6380), MinIO (:9002) — nonstandard ports because the host machine already runs another Postgres on 127.0.0.1:5432 and Redis on :6379
- Verified `pnpm dev` boots all four apps; probed every hello-world endpoint (api, worker, data, web shows api health)
- Full DATA.md schema was generated in one migration rather than per-phase, since DATA.md is the declared source of truth; features still land per phase
**Files changed:** package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, eslint.config.mjs, docker-compose.yml, infra/postgres/init/01-roles.sql, .github/workflows/ci.yml, packages/{core,db}, apps/{api,worker,web}, services/data
**Docs updated:** API.md (health endpoints/ports), ARCHITECTURE.md (two data-service pools, health port), README.md (ports, provider note)
**Tests:** core authz/ids 8 passed; api smoke 4 passed (healthz, readyz, tRPC hello, 404 error format); db setup+migrations ran clean on graphite and graphite_test; verified graphite_readonly denied SELECT on public.users
**Decisions:** MinIO image = `bitnamilegacy/minio` (official `minio/minio` and quay.io removed/blocked in this environment); typescript ~6.0.3 (JS-based; TS 7 is the native compiler, avoided for typescript-eslint compatibility); build scripts for esbuild/msgpackr/protobufjs ignored (postinstalls not required; esbuild binary ships via optional deps)
**Follow-ups:** none for Phase 0