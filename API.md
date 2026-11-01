# API Reference: Graphite

Interfaces: REST, tRPC, Server-Sent Events, WebSocket, gRPC, and MCP. Keep this file in sync with the code.

## 1. Conventions

- Base URL (local): `http://localhost:4000`
- REST prefix: `/api/v1`
- Auth: session cookie (browser) or `Authorization: Bearer <token>` (MCP and API tokens)
- Content type: `application/json` unless noted
- IDs are prefixed strings (`org_...`, `ds_...`)
- Timestamps are ISO 8601 UTC

### Error format
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to edit this dashboard.",
    "requestId": "req_abc123",
    "details": {}
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Validation failed |
| `UNAUTHORIZED` | 401 | Missing or invalid credentials |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Resource missing or not visible to caller |
| `CONFLICT` | 409 | Version conflict or duplicate |
| `PAYLOAD_TOO_LARGE` | 413 | Upload too large |
| `UNPROCESSABLE` | 422 | Semantically invalid (bad CSV, bad spec) |
| `RATE_LIMITED` | 429 | Too many requests (`Retry-After` header) |
| `QUOTA_EXCEEDED` | 429 | Org usage quota reached |
| `INTERNAL` | 500 | Unexpected error |

### Rate limits (defaults, configurable)
| Scope | Limit |
|---|---|
| Per user (API) | 300 req/min |
| Per token (MCP) | 120 req/min |
| Agent runs per org | 30/hour |
| Uploads per user | 20/hour |

---

## 2. REST endpoints

### Health and ops
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | none | Liveness (api :4000, worker :4001, data service :50052) |
| GET | `/readyz` | none | Readiness (Postgres, Redis) |
| GET | `/metrics` | internal | Prometheus metrics |

Each long-running process exposes the same `/healthz` + `/readyz` pair: api on `API_PORT` (4000), the worker on `WORKER_HEALTH_PORT` (4001), and the data service on `DATA_HEALTH_PORT` (50052) next to its gRPC listener on `DATA_GRPC_PORT` (50051).

### Auth
Handled by the auth library under `/api/auth/*` (sign-up, sign-in, sign-out, OAuth callbacks, session, organization endpoints if the library provides them).

### Datasets and uploads
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/projects/:projectId/datasets` | editor | Upload CSV (`multipart/form-data`, field `file`, optional `name`). Returns `202` |
| GET | `/api/v1/datasets/:datasetId` | viewer | Dataset metadata and status |
| GET | `/api/v1/datasets/:datasetId/events` | viewer | SSE: ingestion progress |
| GET | `/api/v1/datasets/:datasetId/preview?limit=100&offset=0` | viewer | Paginated rows |
| GET | `/api/v1/datasets/:datasetId/download` | editor | Original CSV (signed redirect) |
| DELETE | `/api/v1/datasets/:datasetId` | editor | Soft delete; table dropped by maintenance job |

**Upload response (202)**
```json
{
  "dataset": { "id": "ds_8f2k", "status": "queued", "name": "sales_2025.csv" },
  "jobId": "ingest-ds_8f2k"
}
```

**Ingestion SSE events**
```
event: progress
data: {"stage":"loading","rowsProcessed":120000,"percent":62}

event: done
data: {"status":"ready","rowCount":193421}

event: error
data: {"status":"failed","message":"Row 4021: unterminated quote"}
```

### Agent runs
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/runs/:runId/cancel` | editor | Request cancellation |
| GET | `/api/v1/runs/:runId/events` | viewer | SSE: live run events |

**Run SSE events**
```
event: status      data: {"status":"running"}
event: text        data: {"delta":"Looking at revenue by region..."}
event: tool_call   data: {"stepIndex":2,"tool":"run_sql","input":{"sql":"SELECT ..."}}
event: tool_result data: {"stepIndex":2,"rowCount":12,"durationMs":41}
event: chart       data: {"chartId":"chart_1","versionId":"cv_9","version":1}
event: usage       data: {"inputTokens":3120,"outputTokens":804,"costUsd":0.0121}
event: done        data: {"status":"succeeded"}
event: error       data: {"message":"..."}
```

### Public sharing
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/public/dashboards/:shareId` | none | Read-only dashboard, charts, and pre-aggregated chart data |
| GET | `/api/v1/dashboards/:dashboardId/export?format=json\|png` | viewer | Export dashboard |

### Integrations (MCP tokens)
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/orgs/:orgId/mcp/tokens` | editor | List own tokens (prefix, scopes, last used) |
| POST | `/api/v1/orgs/:orgId/mcp/tokens` | editor | Create token; plaintext returned once |
| DELETE | `/api/v1/orgs/:orgId/mcp/tokens/:tokenId` | editor | Revoke |
| GET | `/api/v1/orgs/:orgId/mcp/clients` | editor | Connected clients |

**Create token**
```json
// request
{ "name": "Claude Desktop", "scopes": ["datasets:read", "charts:read", "charts:write"], "expiresInDays": 90 }

// response (201)
{ "id": "tok_1", "token": "gph_live_xxxxxxxxxxxxxxxx", "prefix": "gph_live_xxxx", "expiresAt": "2027-01-30T00:00:00Z" }
```

### Invitations
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/invitations/:token/accept` | session | Accept an invite |

### Optional webhooks (outbound)
| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/orgs/:orgId/webhooks` | owner | Register endpoint (e.g. Slack) for events like `dashboard.shared` |
| GET | `/api/v1/orgs/:orgId/webhooks` | owner | List |
| DELETE | `/api/v1/orgs/:orgId/webhooks/:id` | owner | Remove |

Deliveries are signed (`X-Graphite-Signature`, HMAC-SHA256) and retried by BullMQ.

### OAuth 2.1 for MCP (Phase 10)
| Method | Path | Description |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | Resource metadata |
| GET | `/.well-known/oauth-authorization-server` | Authorization server metadata |
| POST | `/oauth/register` | Dynamic client registration |
| GET | `/oauth/authorize` | Authorization (PKCE required) |
| POST | `/oauth/token` | Token exchange and refresh |
| POST | `/oauth/revoke` | Revocation |

---

## 3. tRPC routers

Mounted at `/trpc`. All procedures are authenticated unless noted; each enforces `authorize()`.

### `org`
| Procedure | Type | Role | Description |
|---|---|---|---|
| `list` | query | any | Orgs for the current user |
| `create` | mutation | any | Create org; caller becomes owner |
| `update` | mutation | owner | Rename, change slug |
| `delete` | mutation | owner | Delete org |

### `member`
| Procedure | Type | Role | Description |
|---|---|---|---|
| `list` | query | viewer | Members and roles |
| `listInvitations` | query | viewer | Pending invitations (token hashes never exposed) |
| `invite` | mutation | owner | Email invitation. Returns `{ invitation, token, inviteUrl }`; email delivery uses the console transport in this environment, so the raw token/link is also returned to the inviter |
| `revokeInvitation` | mutation | owner | Mark an invitation revoked |
| `updateRole` | mutation | owner | Change role (last owner cannot be demoted) |
| `remove` | mutation | owner | Remove member (last owner protected) |
| `leave` | mutation | any | Leave org (last owner must transfer first) |
| `acceptInvite` | mutation | session | Accept a pending invitation with the raw token; caller email must match |

OAuth sign-in (Google/GitHub) is active only when the corresponding client id/secret env vars are set; email + password is always available under `/api/auth/*`.

### `project`
`list`, `get`, `create`, `update`, `delete` (create/update/delete: editor+).

### `dataset`
| Procedure | Type | Role | Description |
|---|---|---|---|
| `list` | query | viewer | By project |
| `get` | query | viewer | Metadata and columns |
| `updateColumnType` | mutation | editor | Override inferred type |
| `rename` | mutation | editor | |
| `query` | query | viewer | Run a validated structured query (used by charts) |

### `dashboard`
| Procedure | Type | Role | Description |
|---|---|---|---|
| `list` | query | viewer | By project |
| `get` | query | viewer | Dashboard, layout, current chart specs |
| `create` / `rename` / `delete` | mutation | editor | |
| `saveLayout` | mutation | editor | Input: `{ dashboardId, baseVersion, items[] }`. Returns new `layoutVersion` or `CONFLICT` with current layout |
| `setShare` | mutation | editor | Enable/disable public link |

### `chart`
| Procedure | Type | Role | Description |
|---|---|---|---|
| `create` | mutation | editor | New chart from a spec (manual) |
| `get` | query | viewer | Chart with current version |
| `versions` | query | viewer | Version history |
| `createVersion` | mutation | editor | Save an edited spec as a new version |
| `revert` | mutation | editor | Create a new version copied from an older one |
| `addToDashboard` / `removeFromDashboard` | mutation | editor | |
| `data` | query | viewer | Query results for rendering a spec |

### `run` (agent)
| Procedure | Type | Role | Description |
|---|---|---|---|
| `start` | mutation | editor | Input: `{ dashboardId, datasetId?, kind, prompt, targetChartId? }`. Returns `{ runId }` |
| `get` | query | viewer | Run detail with steps |
| `list` | query | viewer | Runs for a dashboard or org |
| `conversation` | query | viewer | Messages for a dashboard |

### `integration`
`listTokens`, `createToken`, `revokeToken`, `listClients` (wrappers matching the REST endpoints for the UI).

### `usage`
`orgSummary` (owner): token usage, cost, run counts by day.

---

## 4. WebSocket (Socket.IO)

Namespace: `/collab`. Authentication via session cookie or token at connection. Redis adapter enables multi-instance rooms.

### Client to server
| Event | Payload | Description |
|---|---|---|
| `dashboard:join` | `{ dashboardId }` | Join room after membership check |
| `dashboard:leave` | `{ dashboardId }` | Leave room |
| `presence:update` | `{ dashboardId, selectedChartId?, viewport? }` | Presence info |
| `cursor:move` | `{ dashboardId, x, y }` | Throttled to about 30 Hz |
| `chart:drag` | `{ dashboardId, chartId, x, y, state: "start"|"move"|"end" }` | Show who is moving what (ephemeral) |
| `layout:save` | `{ dashboardId, baseVersion, items[] }` | Same semantics as `dashboard.saveLayout` |

### Server to client
| Event | Payload | Description |
|---|---|---|
| `presence:state` | `{ users: [{ userId, name, color, selectedChartId? }] }` | Full presence snapshot |
| `cursor:update` | `{ userId, x, y }` | Remote cursor |
| `chart:drag` | `{ userId, chartId, x, y, state }` | Remote drag indicator |
| `layout:updated` | `{ layoutVersion, items[], by }` | Accepted layout change |
| `layout:conflict` | `{ currentVersion, items[] }` | Rejected stale write |
| `chart:version-created` | `{ chartId, versionId, version, source }` | New version (user, agent, or MCP) |
| `chart:added` / `chart:removed` | `{ chartId }` | Dashboard membership changes |
| `run:status` | `{ runId, status }` | Agent run lifecycle |

Rules: payloads are Zod-validated; unauthorized joins are rejected; viewers may join but their `layout:save` is denied.

---

## 5. gRPC (orchestrator and MCP server to data service)

`services/data/proto/data.proto`

```proto
syntax = "proto3";
package graphite.data.v1;

service DataService {
  rpc DescribeDataset(DescribeDatasetRequest) returns (DescribeDatasetResponse);
  rpc SampleRows(SampleRowsRequest) returns (RowsResponse);
  rpc ColumnStats(ColumnStatsRequest) returns (ColumnStatsResponse);
  rpc RunQuery(RunQueryRequest) returns (RowsResponse);
}

message Context {
  string organization_id = 1;
  string user_id = 2;
  string request_id = 3;
}

message DescribeDatasetRequest { Context ctx = 1; string dataset_id = 2; }
message DescribeDatasetResponse {
  string dataset_id = 1;
  int64 row_count = 2;
  repeated Column columns = 3;
}
message Column { string name = 1; string type = 2; bool nullable = 3; string stats_json = 4; }

message SampleRowsRequest { Context ctx = 1; string dataset_id = 2; int32 limit = 3; }

message ColumnStatsRequest { Context ctx = 1; string dataset_id = 2; string column = 3; }
message ColumnStatsResponse { string stats_json = 1; }

message RunQueryRequest {
  Context ctx = 1;
  repeated string dataset_ids = 2;   // table allowlist
  string sql = 3;                    // single SELECT only
  int32 row_limit = 4;               // capped server-side
  int32 timeout_ms = 5;              // capped server-side
}

message RowsResponse {
  repeated string columns = 1;
  repeated Row rows = 2;
  bool truncated = 3;
  int32 duration_ms = 4;
}
message Row { repeated string values_json = 1; }
```

Errors map to gRPC status codes: `INVALID_ARGUMENT` (rejected SQL), `DEADLINE_EXCEEDED` (timeout), `PERMISSION_DENIED`, `NOT_FOUND`. Trace context travels in gRPC metadata.

---

## 6. MCP server

- Endpoint: `POST|GET|DELETE /mcp` (Streamable HTTP)
- Auth: `Authorization: Bearer gph_live_...` (OAuth 2.1 in Phase 10)
- Identity: every call runs as the token's user within the token's organization and scopes
- Internal agent uses the same tools through the AI SDK MCP client

### Tools

| Tool | Scope | Description | Input (summary) |
|---|---|---|---|
| `list_projects` | `datasets:read` | Projects in the org | none |
| `list_datasets` | `datasets:read` | Datasets in a project | `projectId` |
| `describe_dataset` | `datasets:read` | Columns, types, stats, row count | `datasetId` |
| `sample_rows` | `datasets:read` | Small sample of rows | `datasetId`, `limit` (max 20) |
| `run_sql` | `datasets:read` | Read-only SELECT with limits | `datasetId`, `sql`, `limit` (max 1000) |
| `list_dashboards` | `charts:read` | Dashboards in a project | `projectId` |
| `list_charts` | `charts:read` | Charts on a dashboard with current specs | `dashboardId` |
| `create_chart_spec` | `charts:write` | Validate and store a new chart | `datasetId`, `spec`, `dashboardId?` |
| `update_chart_spec` | `charts:write` | New version for an existing chart | `chartId`, `spec`, `reason?` |
| `add_chart_to_dashboard` | `charts:write` | Place a chart on a dashboard | `dashboardId`, `chartId`, `position?` |

Tool behavior rules:
- Inputs are Zod-validated; chart specs must pass `packages/chart-spec`.
- Write tools check role (editor+) and write an `audit_logs` entry.
- Write tools publish `chart:version-created` or `chart:added` so open browsers update live.
- Outputs are size-capped; large results are truncated with `truncated: true`.
- There are no delete, membership, or auth tools.

### Resources
| URI | Description |
|---|---|
| `graphite://datasets/{id}/schema` | Schema summary |
| `graphite://dashboards/{id}` | Dashboard layout and chart specs |
| `graphite://chart-spec/schema` | JSON Schema of `ChartSpec` |

### Prompts (optional)
| Name | Description |
|---|---|
| `analyze_dataset` | Guided prompt: explore a dataset and propose charts |
| `remake_chart` | Guided prompt: improve an existing chart |

### Claude Desktop config example
```json
{
  "mcpServers": {
    "graphite": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer gph_live_xxxxxxxxxxxxxxxx" }
    }
  }
}
```
Client config formats vary by client and version, so the Integrations page should render the current recommended snippet.

---

## 7. Versioning and change policy

- REST is versioned by path (`/api/v1`); breaking changes require `/v2`.
- tRPC is internal to the monorepo and versioned with the code.
- MCP tools: adding optional fields is non-breaking; renaming or removing a tool needs a deprecation note in this file.
- Update this file in the same change as any endpoint, event, proto, or tool modification.