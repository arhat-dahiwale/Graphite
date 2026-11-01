/**
 * Scopes for external personal access tokens. Every tool declares the scope
 * it requires; internal agent callers hold all scopes (role checks still
 * apply through the authorize() matrix inside each tool).
 */
export const MCP_SCOPES = ["datasets:read", "charts:read", "charts:write"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** All scopes (internal agent identity). */
export const ALL_SCOPES: McpScope[] = [...MCP_SCOPES];

/** Scope required per tool name (tool name -> scope). */
export const TOOL_SCOPES: Record<string, McpScope> = {
  list_projects: "datasets:read",
  list_datasets: "datasets:read",
  describe_dataset: "datasets:read",
  sample_rows: "datasets:read",
  run_sql: "datasets:read",
  list_dashboards: "charts:read",
  list_charts: "charts:read",
  create_chart_spec: "charts:write",
  update_chart_spec: "charts:write",
  add_chart_to_dashboard: "charts:write",
};

export function hasScope(scopes: string[], required: McpScope | undefined): boolean {
  if (!required) return true; // tools without a scope entry are read-only metadata
  return scopes.includes(required);
}
