import { createHmac, timingSafeEqual } from "node:crypto";
import { unauthorized } from "@graphite/core";

/**
 * Identity propagation for internal callers (the agent orchestrator).
 * The worker signs a compact context header with the auth secret; the MCP
 * server verifies it and executes every tool as that identity. External MCP
 * clients (Phase 7) authenticate with personal access tokens instead — both
 * paths converge on the same ToolContext.
 */
export interface InternalContext {
  userId: string;
  orgId: string;
  requestId: string;
  runId?: string;
  dashboardId?: string;
}

export function signInternalContext(ctx: InternalContext, secret: string): {
  context: string;
  signature: string;
} {
  const context = Buffer.from(JSON.stringify(ctx)).toString("base64url");
  const signature = createHmac("sha256", secret).update(context).digest("base64url");
  return { context, signature };
}

export function verifyInternalContext(
  context: string | undefined,
  signature: string | undefined,
  secret: string,
): InternalContext {
  if (!context || !signature) throw unauthorized("Missing internal identity headers");
  const expected = createHmac("sha256", secret).update(context).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw unauthorized("Invalid internal identity signature");
  }
  const parsed = JSON.parse(Buffer.from(context, "base64url").toString("utf8")) as InternalContext;
  if (!parsed.userId || !parsed.orgId) throw unauthorized("Incomplete internal identity");
  return parsed;
}
