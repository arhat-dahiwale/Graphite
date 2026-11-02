import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { newId } from "@graphite/core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const memberRoleEnum = pgEnum("member_role", ["owner", "editor", "viewer"]);
export const datasetStatusEnum = pgEnum("dataset_status", [
  "uploading",
  "queued",
  "processing",
  "ready",
  "failed",
]);
export const columnTypeEnum = pgEnum("column_type", [
  "number",
  "integer",
  "text",
  "boolean",
  "date",
  "datetime",
]);
export const chartSourceEnum = pgEnum("chart_source", ["manual", "agent", "mcp", "revert"]);
export const runKindEnum = pgEnum("run_kind", ["generate_dashboard", "remake_chart", "ask"]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const agentStepTypeEnum = pgEnum("agent_step_type", [
  "text",
  "tool_call",
  "tool_result",
  "error",
]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "mcp", "system"]);
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

// ---------------------------------------------------------------------------
// Auth tables (managed by Better Auth; field keys match its expectations)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refreshToken: text("refresh_token"),
  accessToken: text("access_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const organizations = pgTable("organizations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("org")),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  "members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("mem")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("members_org_user_idx").on(t.organizationId, t.userId),
    index("members_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("inv")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRoleEnum("role").notNull().default("viewer"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    status: invitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invitations_org_email_idx").on(t.organizationId, t.email)],
);

// ---------------------------------------------------------------------------
// Projects and datasets
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("prj")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("projects_org_deleted_idx").on(t.organizationId, t.deletedAt)],
);

export const datasets = pgTable(
  "datasets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("ds")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    originalFilename: text("original_filename").notNull(),
    storageKey: text("storage_key").notNull(),
    tableName: text("table_name"),
    status: datasetStatusEnum("status").notNull().default("uploading"),
    error: text("error"),
    rowCount: integer("row_count"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    schemaSummary: jsonb("schema_summary"),
    ingestionJobId: text("ingestion_job_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("datasets_project_deleted_idx").on(t.projectId, t.deletedAt),
    index("datasets_org_idx").on(t.organizationId),
  ],
);

export const datasetColumns = pgTable(
  "dataset_columns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("col")),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    originalName: text("original_name").notNull(),
    inferredType: columnTypeEnum("inferred_type").notNull(),
    userType: columnTypeEnum("user_type"),
    nullable: boolean("nullable").notNull().default(true),
    stats: jsonb("stats"),
  },
  (t) => [uniqueIndex("dataset_columns_ds_name_idx").on(t.datasetId, t.name)],
);

// ---------------------------------------------------------------------------
// Dashboards and charts
// ---------------------------------------------------------------------------

export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("dash")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    layoutVersion: integer("layout_version").notNull().default(1),
    shareId: text("share_id").unique(),
    shareEnabled: boolean("share_enabled").notNull().default(false),
    // Dashboard-level filters (Phase 10): validated {field,op,value} list
    // applied on top of each chart's query at read time.
    filters: jsonb("filters"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("dashboards_project_deleted_idx").on(t.projectId, t.deletedAt)],
);

export const charts = pgTable(
  "charts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("chart")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    currentVersionId: text("current_version_id").references((): AnyPgColumn => chartVersions.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("charts_org_deleted_idx").on(t.organizationId, t.deletedAt)],
);

export const chartVersions = pgTable(
  "chart_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("cv")),
    chartId: text("chart_id")
      .notNull()
      .references(() => charts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    spec: jsonb("spec").notNull(),
    source: chartSourceEnum("source").notNull().default("manual"),
    agentRunId: text("agent_run_id"),
    prompt: text("prompt"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chart_versions_chart_version_idx").on(t.chartId, t.versionNumber)],
);

export const dashboardCharts = pgTable(
  "dashboard_charts",
  {
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    chartId: text("chart_id")
      .notNull()
      .references(() => charts.id, { onDelete: "cascade" }),
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    w: integer("w").notNull().default(6),
    h: integer("h").notNull().default(4),
    z: integer("z").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.dashboardId, t.chartId] })],
);

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const conversations = pgTable("conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("conv")),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  dashboardId: text("dashboard_id")
    .notNull()
    .references(() => dashboards.id, { onDelete: "cascade" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("run")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").references(() => datasets.id, { onDelete: "set null" }),
    targetChartId: text("target_chart_id").references(() => charts.id, {
      onDelete: "set null",
    }),
    kind: runKindEnum("kind").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: text("cost_usd").notNull().default("0"),
    error: text("error"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    traceId: text("trace_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_runs_org_created_idx").on(t.organizationId, t.createdAt),
    index("agent_runs_dashboard_idx").on(t.dashboardId),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("step")),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    type: agentStepTypeEnum("type").notNull(),
    toolName: text("tool_name"),
    input: jsonb("input"),
    output: jsonb("output"),
    durationMs: integer("duration_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_steps_run_step_idx").on(t.runId, t.stepIndex)],
);

export const messages = pgTable("messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("msg")),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => newId("audit")),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: actorTypeEnum("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const usageDaily = pgTable("usage_daily", {
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD
  agentRuns: integer("agent_runs").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: text("cost_usd").notNull().default("0"),
}, (t) => [primaryKey({ columns: [t.organizationId, t.date] })]);

export const mcpTokens = pgTable("mcp_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("tok")),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpClients = pgTable("mcp_clients", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("mcl")),
  tokenId: text("token_id")
    .notNull()
    .references(() => mcpTokens.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  clientVersion: text("client_version"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// OAuth 2.1 for MCP (Phase 10): minimal authorization server.
// Data model per DATA.md §6. Tokens are opaque and stored hashed.
// ---------------------------------------------------------------------------

export const oauthClients = pgTable("oauth_clients", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("ocl")),
  clientId: text("client_id").notNull().unique(),
  /** SHA-256 of the client secret; absent for public (PKCE-only) clients. */
  clientSecretHash: text("client_secret_hash"),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  grantTypes: text("grant_types").array().notNull().default(["authorization_code", "refresh_token"]),
  /** Dynamic registration: the registering user binds the client to their org. */
  registeredBy: text("registered_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthCodes = pgTable("oauth_codes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("ocd")),
  codeHash: text("code_hash").notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope").notNull(),
  /** S256(code_verifier) captured at authorize time. */
  codeChallenge: text("code_challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => newId("otk")),
  /** SHA-256 of the opaque token; plaintext never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  kind: text("kind").notNull().default("access"), // access | refresh
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  /** Refresh family id: rotating a refresh token revokes the whole family. */
  familyId: text("family_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations (for typed joins)
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(members),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  datasets: many(datasets),
  dashboards: many(dashboards),
}));

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  project: one(projects, { fields: [datasets.projectId], references: [projects.id] }),
  columns: many(datasetColumns),
}));

export const chartsRelations = relations(charts, ({ one, many }) => ({
  dataset: one(datasets, { fields: [charts.datasetId], references: [datasets.id] }),
  versions: many(chartVersions),
}));

export const chartVersionsRelations = relations(chartVersions, ({ one }) => ({
  chart: one(charts, { fields: [chartVersions.chartId], references: [charts.id] }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [agentRuns.conversationId],
    references: [conversations.id],
  }),
  steps: many(agentSteps),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Member = typeof members.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Dataset = typeof datasets.$inferSelect;
export type DatasetColumn = typeof datasetColumns.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type Chart = typeof charts.$inferSelect;
export type ChartVersion = typeof chartVersions.$inferSelect;
export type DashboardChart = typeof dashboardCharts.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;
export type MemberRole = (typeof memberRoleEnum.enumValues)[number];
export type ColumnType = (typeof columnTypeEnum.enumValues)[number];
export type DatasetStatus = (typeof datasetStatusEnum.enumValues)[number];
