# Data Model: Graphite

PostgreSQL with Drizzle ORM. Source of truth for tables; keep this file in sync with `packages/db`.

## Conventions

- Primary keys: text IDs with prefixes (`org_`, `prj_`, `ds_`, `dash_`, `chart_`, `run_`), generated with nanoid or ULID. Auth-library tables may use their own ID format.
- Timestamps: `created_at` and `updated_at` as `timestamptz`, default `now()`.
- Tenant scoping: tenant tables carry `organization_id`; every query filters by it.
- Soft delete: `deleted_at` on projects, datasets, dashboards, and charts.
- JSON: `jsonb`, validated with Zod before write.

## Schemas

| Schema | Purpose | Access |
|---|---|---|
| `public` | Application tables | App role (read/write) |
| `datasets` | One table per uploaded dataset (`datasets.ds_<id>`) | App role writes during ingestion; `graphite_readonly` has SELECT only |

## Entity overview

```
users ─< members >─ organizations ─< projects ─< datasets ─< dataset_columns
                         │               └────< dashboards ─< dashboard_charts >─ charts ─< chart_versions
                         │
                         ├─< invitations
                         ├─< mcp_tokens
                         ├─< audit_logs
                         └─< agent_runs ─< agent_steps
                                  └── conversations ─< messages
```

## 1. Auth tables (managed by the auth library)

Better Auth (or Auth.js) manages these; names may differ slightly.

| Table | Key columns |
|---|---|
| `users` | `id`, `email` (unique), `name`, `image`, `email_verified`, timestamps |
| `sessions` | `id`, `user_id` → users, `token`, `expires_at`, `ip`, `user_agent` |
| `accounts` | `id`, `user_id` → users, `provider`, `provider_account_id`, tokens |
| `verifications` | `id`, `identifier`, `value`, `expires_at` |

## 2. Organizations

### `organizations`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `org_...` |
| name | text | |
| slug | text unique | URL-safe |
| created_by | text → users | |
| created_at, updated_at | timestamptz | |

### `members`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| organization_id | text → organizations | |
| user_id | text → users | |
| role | enum(`owner`,`editor`,`viewer`) | |
| created_at | timestamptz | |

Unique: (`organization_id`, `user_id`). Index: `user_id`.

### `invitations`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| organization_id | text → organizations | |
| email | text | |
| role | enum | |
| token_hash | text | Hashed invite token |
| invited_by | text → users | |
| status | enum(`pending`,`accepted`,`revoked`,`expired`) | |
| expires_at | timestamptz | |

Index: (`organization_id`, `email`).

## 3. Projects and datasets

### `projects`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `prj_...` |
| organization_id | text → organizations | |
| name | text | |
| description | text null | |
| created_by | text → users | |
| deleted_at | timestamptz null | |

Index: (`organization_id`, `deleted_at`).

### `datasets`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `ds_...` |
| organization_id | text → organizations | Denormalized for tenant filter |
| project_id | text → projects | |
| name | text | |
| original_filename | text | |
| storage_key | text | Object storage path of raw CSV |
| table_name | text null | `ds_<id>` inside the `datasets` schema once ready |
| status | enum(`uploading`,`queued`,`processing`,`ready`,`failed`) | |
| error | text null | Failure reason |
| row_count | bigint null | |
| size_bytes | bigint | |
| schema_summary | jsonb null | Compact description cached for agent prompts |
| ingestion_job_id | text null | BullMQ job ID |
| created_by | text → users | |
| deleted_at | timestamptz null | |

Index: (`project_id`, `deleted_at`), (`organization_id`).

### `dataset_columns`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| dataset_id | text → datasets | |
| position | int | Column order |
| name | text | Sanitized name used in SQL |
| original_name | text | Header from CSV |
| inferred_type | enum(`number`,`integer`,`text`,`boolean`,`date`,`datetime`) | |
| user_type | same enum null | Manual override |
| nullable | boolean | |
| stats | jsonb null | min, max, distinct count, null count, top values |

Unique: (`dataset_id`, `name`).

## 4. Dashboards and charts

### `dashboards`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `dash_...` |
| organization_id | text → organizations | |
| project_id | text → projects | |
| name | text | |
| layout_version | int | Incremented on each accepted layout write |
| share_id | text unique null | Public read-only link ID |
| share_enabled | boolean | |
| filters | jsonb null | Dashboard-level filters; validated `{field, op, value}` list applied through the chart query compiler |
| created_by | text → users | |
| deleted_at | timestamptz null | |

### `charts`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `chart_...` |
| organization_id | text → organizations | |
| dataset_id | text → datasets | |
| title | text | Mirrors the latest spec title |
| current_version_id | text null → chart_versions | Latest version |
| created_by | text → users | |
| deleted_at | timestamptz null | |

### `chart_versions`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| chart_id | text → charts | |
| version_number | int | 1, 2, 3, … |
| spec | jsonb | Validated `ChartSpec` |
| source | enum(`manual`,`agent`,`mcp`,`revert`) | |
| agent_run_id | text null → agent_runs | |
| prompt | text null | Instruction that produced it |
| created_by | text → users | |
| created_at | timestamptz | |

Unique: (`chart_id`, `version_number`). Versions are immutable.

### `dashboard_charts`
Placement of a chart on a dashboard.

| Column | Type | Notes |
|---|---|---|
| dashboard_id | text → dashboards | |
| chart_id | text → charts | |
| x, y | int | Grid position |
| w, h | int | Grid size |
| z | int | Stacking order |

PK: (`dashboard_id`, `chart_id`). A layout save replaces all rows for a dashboard in one transaction guarded by `layout_version`.

## 5. Agent

### `conversations`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| organization_id | text → organizations | |
| dashboard_id | text → dashboards | |
| created_by | text → users | |

### `messages`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| conversation_id | text → conversations | |
| role | enum(`user`,`assistant`) | |
| content | text | |
| run_id | text null → agent_runs | |
| created_at | timestamptz | |

### `agent_runs`
| Column | Type | Notes |
|---|---|---|
| id | text PK | `run_...` |
| organization_id | text → organizations | |
| conversation_id | text → conversations | |
| dashboard_id | text → dashboards | |
| dataset_id | text null → datasets | |
| target_chart_id | text null → charts | Set for re-make runs |
| kind | enum(`generate_dashboard`,`remake_chart`,`ask`) | |
| status | enum(`queued`,`running`,`succeeded`,`failed`,`cancelled`) | |
| model | text | |
| input_tokens, output_tokens | int | |
| cost_usd | numeric(10,6) | |
| error | text null | |
| cancel_requested | boolean | Checked between steps |
| started_at, finished_at | timestamptz null | |
| trace_id | text null | OpenTelemetry trace ID |
| created_by | text → users | |

Index: (`organization_id`, `created_at` desc), (`dashboard_id`).

### `agent_steps`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| run_id | text → agent_runs | |
| step_index | int | |
| type | enum(`text`,`tool_call`,`tool_result`,`error`) | |
| tool_name | text null | |
| input | jsonb null | Tool arguments |
| output | jsonb null | Truncated tool result |
| duration_ms | int null | |
| input_tokens, output_tokens | int null | |
| created_at | timestamptz | |

Unique: (`run_id`, `step_index`).

## 6. MCP and integrations

### `mcp_tokens`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| user_id | text → users | |
| organization_id | text → organizations | Token scoped to one org |
| name | text | Label such as "Claude Desktop" |
| token_hash | text unique | SHA-256 of the token; plaintext shown once |
| token_prefix | text | First characters for display |
| scopes | text[] | e.g. `charts:read`, `charts:write`, `datasets:read` |
| last_used_at | timestamptz null | |
| expires_at | timestamptz null | |
| revoked_at | timestamptz null | |

### `mcp_clients`
Connected-client records shown on the Integrations page.

| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| token_id | text → mcp_tokens | |
| client_name | text | From MCP `initialize` |
| client_version | text null | |
| first_seen_at, last_seen_at | timestamptz | |

### `oauth_clients`, `oauth_codes`, `oauth_tokens` (Phase 10)

Minimal OAuth 2.1 authorization server for MCP (hand-rolled; Better Auth ships OAuth *client* plugins only, no provider).

| Table | Key columns |
|---|---|
| `oauth_clients` | `id`, `client_id` unique, `client_secret_hash` (null for public PKCE clients), `name`, `redirect_uris[]`, `registered_by` → users, `organization_id` (tenant binding) |
| `oauth_codes` | `id`, `code_hash` unique (SHA-256), `client_id`, `user_id`, `organization_id`, `redirect_uri`, `scope`, `code_challenge` (S256), `expires_at` (10 min), `used_at` (single use) |
| `oauth_tokens` | `id`, `token_hash` unique (SHA-256), `kind` (`access`\|`refresh`), `client_id`, `user_id`, `organization_id`, `scope`, `family_id` (rotation: refresh revokes the family), `expires_at`, `revoked_at` |

Access tokens are opaque (`gphat_...`), accepted by the MCP router exactly like personal access tokens; revocation (RFC 7009) kills the token family.

## 7. Operations

### `audit_logs`
| Column | Type | Notes |
|---|---|---|
| id | text PK | |
| organization_id | text → organizations | |
| actor_user_id | text null → users | |
| actor_type | enum(`user`,`agent`,`mcp`,`system`) | |
| action | text | e.g. `chart.update`, `member.remove`, `token.create` |
| resource_type, resource_id | text | |
| metadata | jsonb null | No secrets or raw data |
| created_at | timestamptz | |

Index: (`organization_id`, `created_at` desc).

### `usage_daily`
Per-org rollups for quotas.

| Column | Type | Notes |
|---|---|---|
| organization_id | text | |
| date | date | |
| agent_runs | int | |
| input_tokens, output_tokens | bigint | |
| cost_usd | numeric | |

PK: (`organization_id`, `date`).

## 8. Dataset tables

Created by the ingestion worker as `datasets.ds_<id>`:
- Columns match `dataset_columns.name` with Postgres types mapped from inferred types.
- A synthetic `_row_id bigserial` primary key is added.
- Identifiers are generated, never taken raw from user input.
- `graphite_readonly` gets `SELECT` on each table after ingestion succeeds.
- Dropping a dataset drops its table and the raw object-storage file.

## 9. Roles and permissions

| Postgres role | Access |
|---|---|
| `graphite_app` | Read/write `public`; create/write in `datasets` |
| `graphite_readonly` | SELECT on `datasets` only; `statement_timeout` set at role level |

| App role | Capabilities |
|---|---|
| owner | Everything, including members, tokens for the org, deletion |
| editor | Create and edit projects, datasets, dashboards, charts; run the agent; create own tokens |
| viewer | Read dashboards and charts; interact with filters; no edits or agent runs |

## 10. Redis keys (not in Postgres)

| Key pattern | Purpose | TTL |
|---|---|---|
| `bull:*` | BullMQ queues | n/a |
| `presence:{dashboardId}` | Hash of userId to presence data | ~30 s, refreshed |
| `cursor:{dashboardId}:{userId}` | Last cursor position | ~10 s |
| `run:{runId}:events` | Pub/sub channel for run events | n/a |
| `dataset:{datasetId}:events` | Pub/sub channel for ingestion progress | n/a |
| `dash:{dashboardId}:events` | Pub/sub channel for dashboard events | n/a |
| `rl:{scope}:{id}` | Rate limit counters | window |
| `schema:{datasetId}` | Cached schema summary | 1 h |

## 11. Index and integrity checklist

- Foreign keys with `ON DELETE` policies defined explicitly (cascade for children, restrict for users).
- Unique constraints noted above are enforced in the database.
- `chart_versions` and `agent_steps` are append-only.
- Migrations are forward-only and reviewed.