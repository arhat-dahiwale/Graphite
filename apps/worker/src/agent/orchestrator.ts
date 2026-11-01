import { streamText, stepCountIs, type ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { childLogger, runEventsChannel, type RunEvent } from "@graphite/core";
import {
  agentCostUsd,
  agentRunDuration,
  agentRunTotal,
  agentTokens,
} from "@graphite/telemetry/metrics";
import { currentTraceId, startSpanFor } from "@graphite/telemetry";
import { context as otelContext, SpanStatusCode, type Span } from "@opentelemetry/api";
import { and, asc, eq } from "drizzle-orm";
import { agentRuns, agentSteps, datasets, messages } from "@graphite/db/schema";
import type { Database } from "@graphite/db/client";
import type Redis from "ioredis";
import type { Sql } from "postgres";
import { getCurrentVersion } from "@graphite/db/repo/charts";
import { getDatasetColumns } from "@graphite/db/repo/datasets";
import { signInternalContext } from "@graphite/mcp-server/internal-auth";
import { createModel } from "./provider.js";
import { buildRunUserPrompt, buildSystemPrompt } from "./prompts.js";

const log = childLogger({ component: "orchestrator" });

const MAX_STEPS = 16;

export interface OrchestratorDeps {
  db: Database;
  sql: Sql;
  redis: Redis;
  /** Base URL of the internal MCP server (mounted in this worker process). */
  mcpBaseUrl: string;
  /** Secret used to sign the internal identity headers. */
  mcpSecret: string;
  tokenBudget: number;
}

/**
 * Phase 5: the orchestrator connects to the MCP server as its ONLY tool
 * source. Identity (user, org, run, dashboard) travels in signed internal
 * headers, so every tool call executes with the run's identity and passes
 * through the same MCP path external clients use.
 */
async function connectAgentMcpClient(opts: {
  baseUrl: string;
  secret: string;
  userId: string;
  orgId: string;
  runId: string;
  dashboardId: string;
}): Promise<{ client: Awaited<ReturnType<typeof createMCPClient>>; tools: ToolSet }> {
  const { context, signature } = signInternalContext(
    {
      userId: opts.userId,
      orgId: opts.orgId,
      runId: opts.runId,
      dashboardId: opts.dashboardId,
      requestId: opts.runId,
    },
    opts.secret,
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${opts.baseUrl}/mcp`), {
    requestInit: {
      headers: {
        "x-graphite-internal-context": context,
        "x-graphite-internal-signature": signature,
      },
    },
  });
  const client = await createMCPClient({ transport });
  const tools = await client.tools();
  return { client, tools };
}

async function isCancelRequested(db: Database, runId: string): Promise<boolean> {
  const rows = await db
    .select({ cancelRequested: agentRuns.cancelRequested })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return rows[0]?.cancelRequested ?? false;
}

/**
 * Execute an agent run end to end: build prompts, stream the model through
 * the tool loop, persist every step, publish events to Redis, and enforce
 * the token budget and the cancel flag between steps.
 */
export async function executeRun(deps: OrchestratorDeps, runId: string): Promise<void> {
  const runStart = Date.now();
  const runRows = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = runRows[0];
  if (!run) throw new Error(`Run ${runId} not found`);

  // Persist the OpenTelemetry trace id so the in-app trace viewer and the
  // end-to-end trace check can find the run's trace ("" when tracing is off).
  const traceId = currentTraceId();
  if (traceId) {
    await deps.db.update(agentRuns).set({ traceId }).where(eq(agentRuns.id, runId));
  }

  let seq = 0;
  const publish = async (type: RunEvent["type"], data: Record<string, unknown>): Promise<void> => {
    seq += 1;
    const event: RunEvent = { type, runId, seq, at: new Date().toISOString(), data };
    await deps.redis.publish(runEventsChannel(runId), JSON.stringify(event));
  };

  let stepIndex = 0;
  const persistStep = async (row: {
    type: "text" | "tool_call" | "tool_result" | "error";
    toolName?: string;
    input?: unknown;
    output?: unknown;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> => {
    const idx = stepIndex;
    stepIndex += 1;
    await deps.db.insert(agentSteps).values({ runId, stepIndex: idx, ...row });
  };

  await deps.db
    .update(agentRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(agentRuns.id, runId));
  await publish("status", { status: "running" });

  const controller = new AbortController();
  let budgetExceeded = false;
  let cancelHit = false;
  let totalInput = 0;
  let totalOutput = 0;
  let assistantText = "";

  const finishRun = async (status: "succeeded" | "cancelled" | "failed", error?: string) => {
    await deps.db
      .update(agentRuns)
      .set({
        status,
        error: error ?? null,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    // Prometheus: run count, duration, tokens. Cost is intentionally not
    // recorded for mock runs (figures are simulated).
    const model = run.model;
    agentRunTotal.inc({ status, model });
    agentRunDuration.observe({ status, model }, (Date.now() - runStart) / 1000);
    if (totalInput > 0) agentTokens.inc({ direction: "input", model }, totalInput);
    if (totalOutput > 0) agentTokens.inc({ direction: "output", model }, totalOutput);
    // Cost figures for mock runs are simulated (0 by design); real-model runs
    // would carry provider pricing here.
    agentCostUsd.inc({ model }, Number(run.costUsd ?? "0") || 0);
  };

  try {
    if (!run.datasetId) throw new Error("Run has no dataset");
    const dsRows = await deps.db
      .select()
      .from(datasets)
      .where(eq(datasets.id, run.datasetId))
      .limit(1);
    const ds = dsRows[0];
    if (!ds || !ds.tableName) throw new Error("Dataset is not ready");
    const cols = await getDatasetColumns(deps.db, ds.id);
    const schema = {
      datasetId: ds.id,
      tableName: ds.tableName,
      rowCount: ds.rowCount ?? 0,
      columns: cols.map((c) => ({
        name: c.name,
        type: c.userType ?? c.inferredType,
      })),
    };

    // The user prompt was persisted at run creation (role "user", runId).
    const promptRows = await deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.runId, runId), eq(messages.role, "user")))
      .orderBy(asc(messages.createdAt))
      .limit(1);
    const userPromptText = promptRows[0]?.content ?? "Build a dashboard from this dataset.";

    let targetSpec: unknown = null;
    if (run.kind === "remake_chart" && run.targetChartId) {
      const version = await getCurrentVersion(deps.db, run.targetChartId);
      targetSpec = version?.spec ?? null;
    }

    const system = buildSystemPrompt();
    const userPrompt = buildRunUserPrompt({
      kind: run.kind,
      schema,
      userPrompt: userPromptText,
      targetChartId: run.targetChartId,
      targetChartSpec: targetSpec,
    });

    const { model, modelId } = createModel({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    });

    const { client: mcpClient, tools } = await connectAgentMcpClient({
      baseUrl: deps.mcpBaseUrl,
      secret: deps.mcpSecret,
      userId: run.createdBy,
      orgId: run.organizationId,
      runId,
      dashboardId: run.dashboardId,
    });

    // One span for the whole LLM call (the model loop), children per tool call.
    const { span: llmSpan, ctx: llmCtx } = startSpanFor(undefined, "agent.llm", {
      "gen_ai.system": "graphite",
      "gen_ai.request.model": modelId,
    });
    const toolSpans = new Map<string, Span>();

    try {
    const result = await (async () => {
      // streamText runs with the LLM span active so SDK-emitted model spans
      // (when present) attach underneath.
      return otelContext.with(llmCtx, () =>
        streamText({
          model,
          system,
          messages: [{ role: "user" as const, content: userPrompt }],
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          abortSignal: controller.signal,
          // OTel spans for the LLM call (ai.streamText + ai.toolCall children);
          // only active when tracing is enabled (OTEL_ENABLED=true).
          experimental_telemetry: { isEnabled: currentTraceId() !== "" },
          onStepFinish: async (step) => {
            // Budget + cancel checks happen BETWEEN steps.
            totalInput += step.usage?.inputTokens ?? 0;
            totalOutput += step.usage?.outputTokens ?? 0;
            await persistStep({
              type: "text",
              output: { text: step.text ?? "" },
              inputTokens: step.usage?.inputTokens ?? 0,
              outputTokens: step.usage?.outputTokens ?? 0,
            });
            await publish("usage", {
              inputTokens: totalInput,
              outputTokens: totalOutput,
              costUsd: modelId === "mock-scripted" ? 0 : undefined,
            });
            if (totalInput + totalOutput > deps.tokenBudget) {
              budgetExceeded = true;
              controller.abort();
              return;
            }
            if (await isCancelRequested(deps.db, runId)) {
              cancelHit = true;
              controller.abort();
            }
          },
        }),
      );
    })();

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const delta = (part as { delta?: string }).delta ?? "";
        assistantText += delta;
        await publish("text", { delta });
      } else if (part.type === "tool-call") {
        const p = part as unknown as { toolCallId: string; toolName: string; input: unknown };
        // Child span per tool call, ended when its result arrives.
        const { span: toolSpan } = startSpanFor(llmCtx, `agent.tool ${p.toolName}`, {
          "graphite.tool": p.toolName,
        });
        toolSpans.set(p.toolCallId, toolSpan);
        await persistStep({ type: "tool_call", toolName: p.toolName, input: p.input });
        await publish("tool_call", { toolName: p.toolName, input: p.input });
      } else if (part.type === "tool-result") {
        const p = part as unknown as {
          toolCallId: string;
          toolName: string;
          input: unknown;
          output: unknown;
        };
        toolSpans.get(p.toolCallId)?.end();
        toolSpans.delete(p.toolCallId);
        await persistStep({
          type: "tool_result",
          toolName: p.toolName,
          input: p.input,
          output: p.output,
        });
        await publish("tool_result", { toolName: p.toolName, output: p.output });
        if (p.toolName === "create_chart_spec" && p.output && typeof p.output === "object") {
          const out = p.output as { chartId?: string; versionId?: string; version?: number };
          if (out.chartId) {
            await publish("chart", {
              chartId: out.chartId,
              versionId: out.versionId,
              version: out.version,
            });
          }
        }
      } else if (part.type === "tool-error") {
        // Tool execution or input-validation errors are surfaced to the model
        // as feedback so it can retry with corrected arguments.
        const p = part as unknown as { toolCallId: string; toolName: string; input: unknown; error: unknown };
        const message = p.error instanceof Error ? p.error.message : String(p.error);
        const toolSpan = toolSpans.get(p.toolCallId);
        if (toolSpan) {
          toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 200) });
          toolSpan.end();
          toolSpans.delete(p.toolCallId);
        }
        await persistStep({
          type: "tool_result",
          toolName: p.toolName,
          input: p.input,
          output: { error: message.slice(0, 500) },
        });
        await publish("tool_result", { toolName: p.toolName, output: { error: message.slice(0, 500) } });
      } else if (part.type === "error") {
        const p = part as unknown as { error: unknown };
        const message = p.error instanceof Error ? p.error.message : String(p.error);
        await persistStep({ type: "error", output: { message: message.slice(0, 500) } });
        await publish("error", { message: message.slice(0, 500) });
      }
    }

    const finalUsage = await result.usage;
    totalInput = finalUsage?.inputTokens ?? totalInput;
    totalOutput = finalUsage?.outputTokens ?? totalOutput;
    // The whole model loop finished; close the LLM span.
    llmSpan.end();
    for (const s of toolSpans.values()) s.end();
    toolSpans.clear();

    // Persist the assistant reply for the conversation history.
    if (assistantText.length > 0) {
      await deps.db.insert(messages).values({
        conversationId: run.conversationId,
        role: "assistant",
        content: assistantText,
        runId,
      });
    }

    if (cancelHit || (await isCancelRequested(deps.db, runId))) {
      await finishRun("cancelled");
      await publish("done", { status: "cancelled" });
      return;
    }
    if (budgetExceeded) {
      const msg = `Token budget exceeded (${totalInput}+${totalOutput} > ${deps.tokenBudget})`;
      await finishRun("failed", msg);
      await publish("error", { message: msg });
      await publish("done", { status: "failed" });
      return;
    }

    await finishRun("succeeded");
    await publish("done", { status: "succeeded" });
    } finally {
      // Idempotent: end() is a no-op if the span already ended on success.
      llmSpan.end();
      for (const s of toolSpans.values()) s.end();
      toolSpans.clear();
      await mcpClient.close().catch(() => undefined);
    }
  } catch (e) {
    if (budgetExceeded) {
      const msg = `Token budget exceeded (${totalInput}+${totalOutput} > ${deps.tokenBudget})`;
      await finishRun("failed", msg);
      await publish("error", { message: msg });
      await publish("done", { status: "failed" });
      return;
    }
    if (controller.signal.aborted) {
      await finishRun("cancelled");
      await publish("done", { status: "cancelled" });
      return;
    }
    const message = e instanceof Error ? e.message : "Run failed";
    log.error({ err: e, runId }, "agent run failed");
    await finishRun("failed", message.slice(0, 500));
    await publish("error", { message: message.slice(0, 500) });
    await publish("done", { status: "failed" });
  }
}
