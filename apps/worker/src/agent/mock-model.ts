import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { ColumnType } from "@graphite/core";

/**
 * Deterministic scripted mock model (labeled `mock-scripted`).
 *
 * It goes through the exact same AI SDK streamText/tool pipeline as a real
 * provider — same tools, same validation, same streaming — only the model
 * implementation differs. The script inspects the conversation state in the
 * prompt (structured tool results so far) and emits the next action.
 *
 * Script for a "build a dashboard" run:
 *   1. text + describe_dataset
 *   2. text + run_sql (sample)
 *   3. create_chart_spec (bar: categorical x + numeric y)
 *   4. create_chart_spec (line: date x + numeric y)
 *   5. create_chart_spec (pie: categorical x + aggregated numeric y)
 *   6. closing text
 * For a "re-make chart" run it calls update_chart_spec with a visibly
 * different valid spec (type swap).
 *
 * Charts are derived from the dataset schema embedded in the user prompt
 * (GRAPHITE_DATASET_SCHEMA JSON block) — never hardcoded column names.
 */

export interface MockDatasetSchema {
  datasetId: string;
  tableName: string;
  rowCount: number;
  columns: Array<{ name: string; type: ColumnType }>;
}

const MOCK_USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
};

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
  ];
}

function toolCallPart(id: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: JSON.stringify(input) },
    { type: "tool-input-end", id },
    {
      type: "tool-call",
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
  ];
}

/** MCP results carry errors as isError text/json content; detect all shapes. */
function outputIndicatesError(
  output: { type?: string; value?: unknown; isError?: unknown; content?: unknown },
): boolean {
  if (output.isError === true) return true;
  const type = output.type ?? "";
  if (type.startsWith("error") || type === "execution-denied") return true;
  if (type === "text" && typeof output.value === "string") {
    try {
      const v = JSON.parse(output.value) as { error?: unknown };
      return v !== null && typeof v === "object" && typeof v.error === "string";
    } catch {
      return false;
    }
  }
  if (type === "json" && output.value !== null && typeof output.value === "object") {
    const v = output.value as {
      error?: unknown;
      isError?: unknown;
      content?: Array<{ text?: string }>;
    };
    if (typeof v.error === "string") return true;
    if (v.isError === true) return true;
    if (Array.isArray(v.content)) {
      return contentArrayIndicatesError(v.content);
    }
  }
  // MCP dynamic tools surface results as { type: "content", value: ContentBlock[] }.
  if (type === "content" && Array.isArray(output.value)) {
    return contentArrayIndicatesError(output.value as Array<{ type?: string; text?: string }>);
  }
  return false;
}

function contentArrayIndicatesError(content: Array<{ type?: string; text?: string }>): boolean {
  for (const c of content) {
    if (typeof c.text === "string") {
      try {
        const inner = JSON.parse(c.text) as { error?: unknown };
        if (inner !== null && typeof inner === "object" && typeof inner.error === "string") {
          return true;
        }
      } catch {
        // Not JSON: a plain-text tool error message.
        if (c.text.startsWith("Error:")) return true;
      }
    }
  }
  return false;
}

function safeParseSchema(text: string): MockDatasetSchema | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as MockDatasetSchema;
  } catch {
    return null;
  }
}

function safeParseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickColumns(schema: MockDatasetSchema): {
  categorical: string | null;
  numeric: string | null;
  date: string | null;
} {
  let categorical: string | null = null;
  let numeric: string | null = null;
  let date: string | null = null;
  for (const c of schema.columns) {
    if (date === null && (c.type === "date" || c.type === "datetime")) date = c.name;
    if (numeric === null && (c.type === "number" || c.type === "integer")) numeric = c.name;
    if (categorical === null && (c.type === "text" || c.type === "boolean")) categorical = c.name;
  }
  return { categorical, numeric, date };
}

function specFor(
  schema: MockDatasetSchema,
  type: "bar" | "line" | "pie",
  title: string,
): Record<string, unknown> {
  const { categorical, numeric, date } = pickColumns(schema);
  const xField =
    type === "line"
      ? (date ?? categorical ?? schema.columns[0]?.name ?? "x")
      : (categorical ?? date ?? schema.columns[0]?.name ?? "x");
  const yField = numeric ?? categorical ?? schema.columns[0]?.name ?? "y";
  const isCount = numeric === null;
  return {
    version: 1,
    type,
    title,
    datasetId: schema.datasetId,
    query: {
      select: [
        { field: xField },
        { field: yField, agg: isCount ? "count" : "sum", as: "value" },
      ],
      groupBy: [xField],
      orderBy: [{ field: "value", dir: "desc" }],
      limit: 50,
    },
    encoding: {
      x: { field: xField, type: type === "line" ? "temporal" : "category" },
      y: { field: yField, type: "number" },
    },
    style: { palette: type === "pie" ? "ember" : "graphite", legend: false, stack: false },
  };
}

/** Produce a visibly different, still-valid spec (type swap + retitled). */
export function visiblyDifferentSpec(
  base: Record<string, unknown> | null,
  schema: MockDatasetSchema,
): Record<string, unknown> {
  if (!base) {
    return specFor(schema, "bar", "Re-made chart");
  }
  const typeSwaps: Record<string, "bar" | "line" | "pie" | "area" | "histogram"> = {
    bar: "line",
    line: "bar",
    pie: "bar",
    area: "bar",
    histogram: "pie",
  };
  const currentType = String(base.type ?? "bar");
  const nextType = typeSwaps[currentType] ?? "bar";
  const spec: Record<string, unknown> = { ...base };
  spec.type = nextType;
  spec.title = `${String(base.title ?? "Chart")} (re-made)`;
  const encoding = { ...((spec.encoding as Record<string, unknown>) ?? {}) };
  const xField = (encoding.x as { field?: string } | undefined)?.field ?? "x";
  const yField = (encoding.y as { field?: string } | undefined)?.field ?? "y";
  if (nextType === "pie") {
    encoding.x = { field: xField, type: "category" };
    encoding.y = { field: yField, type: "number" };
  }
  if (nextType === "line") {
    encoding.x = { field: xField, type: "temporal" };
  }
  spec.encoding = encoding;
  return spec;
}

interface ScriptState {
  resultCounts: Map<string, { ok: number; error: number }>;
  schema: MockDatasetSchema | null;
  runKind: string;
  targetChartId: string | null;
  targetSpec: Record<string, unknown> | null;
  testFlag: string | null;
}

function readScriptState(options: LanguageModelV4CallOptions): ScriptState {
  const resultCounts = new Map<string, { ok: number; error: number }>();
  let schemaText: string | null = null;
  let runKind = "generate_dashboard";
  let targetChartId: string | null = null;
  let targetSpecText: string | null = null;
  let testFlag: string | null = null;

  for (const msg of options.prompt) {
    if (msg.role === "tool" || msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          if (outputIndicatesError(part.output as { type?: string; value?: unknown })) {
            const entry = resultCounts.get(part.toolName) ?? { ok: 0, error: 0 };
            entry.error += 1;
            resultCounts.set(part.toolName, entry);
          } else {
            const entry = resultCounts.get(part.toolName) ?? { ok: 0, error: 0 };
            entry.ok += 1;
            resultCounts.set(part.toolName, entry);
          }
        }
      }
    }
    if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type !== "text") continue;
        const text = part.text;
        if (schemaText === null) {
          const marker = text.indexOf("GRAPHITE_DATASET_SCHEMA:");
          if (marker >= 0) {
            const after = text.slice(marker + "GRAPHITE_DATASET_SCHEMA:".length);
            const startBrace = after.indexOf("{");
            const endFence = after.indexOf("```", startBrace >= 0 ? startBrace : 0);
            schemaText = endFence >= 0 ? after.slice(0, endFence) : after;
          }
        }
        const kindMatch = /GRAPHITE_RUN_KIND:(\w+)/.exec(text);
        if (kindMatch) runKind = kindMatch[1] ?? runKind;
        const targetMatch = /GRAPHITE_TARGET_CHART_ID:([a-z0-9_]+)/.exec(text);
        if (targetMatch) targetChartId = targetMatch[1] ?? null;
        const specMatch = /GRAPHITE_TARGET_SPEC:([\s\S]*?)GRAPHITE_TARGET_SPEC_END/.exec(text);
        if (specMatch) targetSpecText = specMatch[1] ?? null;
        const testMatch = /GRAPHITE_TEST:(\w+)/.exec(text);
        if (testMatch) testFlag = testMatch[1] ?? null;
      }
    }
  }

  return {
    resultCounts,
    schema: schemaText ? safeParseSchema(schemaText) : null,
    runKind,
    targetChartId,
    targetSpec: safeParseJson(targetSpecText),
    testFlag,
  };
}

/** Build the next scripted response from the conversation so far. */
export function scriptNextResponse(options: LanguageModelV4CallOptions): {
  parts: LanguageModelV4StreamPart[];
  finishReason: "tool-calls" | "stop";
} {
  const state = readScriptState(options);
  const createdOk = state.resultCounts.get("create_chart_spec")?.ok ?? 0;
  const createdErr = state.resultCounts.get("create_chart_spec")?.error ?? 0;
  const updateOk = state.resultCounts.get("update_chart_spec")?.ok ?? 0;
  const updateErr = state.resultCounts.get("update_chart_spec")?.error ?? 0;
  const described = (state.resultCounts.get("describe_dataset")?.ok ?? 0) > 0;
  const sampled = (state.resultCounts.get("run_sql")?.ok ?? 0) > 0;

  if (state.runKind === "remake_chart") {
    if (updateOk === 0 && updateErr === 0) {
      const schema =
        state.schema ??
        ({ datasetId: "ds_unknown", tableName: "ds_unknown", rowCount: 0, columns: [] } as MockDatasetSchema);
      const newSpec = visiblyDifferentSpec(state.targetSpec, schema);
      return {
        parts: [
          ...textParts("Re-making the chart with a different visualization."),
          ...toolCallPart("call_update_1", "update_chart_spec", {
            chartId: state.targetChartId ?? "chart_unknown",
            spec: newSpec,
            reason: "Scripted re-make: changed chart type for a different view",
          }),
        ],
        finishReason: "tool-calls",
      };
    }
    return {
      parts: textParts("Chart re-made. The new version is on your dashboard."),
      finishReason: "stop",
    };
  }

  if (!state.schema) {
    return {
      parts: textParts("I could not find the dataset schema in this conversation."),
      finishReason: "stop",
    };
  }

  if (!described) {
    return {
      parts: [
        ...textParts("Let me look at the dataset schema first."),
        ...toolCallPart("call_desc_1", "describe_dataset", { datasetId: state.schema.datasetId }),
      ],
      finishReason: "tool-calls",
    };
  }

  if (!sampled) {
    return {
      parts: [
        ...textParts("Schema looks good. Let me peek at a few rows."),
        ...toolCallPart("call_sql_1", "run_sql", {
          datasetId: state.schema.datasetId,
          sql: `SELECT * FROM datasets."${state.schema.tableName}" LIMIT 5`,
          limit: 5,
        }),
      ],
      finishReason: "tool-calls",
    };
  }

  // Chart progression is a pure function of (createdOk, createdErr): a
  // correction repeats until the first success, then slots advance normally.
  if (createdOk < 3) {
    if (createdOk === 0 && createdErr > 0) {
      return {
        parts: [
          ...textParts("The previous spec was invalid. Let me correct it."),
          ...toolCallPart("call_create_retry_0", "create_chart_spec", {
            spec: specFor(state.schema, "bar", "Chart 1 (corrected)"),
          }),
        ],
        finishReason: "tool-calls",
      };
    }
    const plans: Array<{ type: "bar" | "line" | "pie"; title: string }> = [
      { type: "bar", title: "Breakdown by category" },
      { type: "line", title: "Trend over time" },
      { type: "pie", title: "Share by category" },
    ];
    const slot = createdOk;
    const plan = plans[slot] as { type: "bar" | "line" | "pie"; title: string };
    const invalidFirst = state.testFlag === "invalid_spec_first" && slot === 0 && createdErr === 0;
    const specInput = invalidFirst
      ? {
          ...(specFor(state.schema, "bar", plan.title) as Record<string, unknown>),
          type: "wordcloud",
          version: 1,
        }
      : specFor(state.schema, plan.type, plan.title);
    return {
      parts: [
        ...textParts(`Building chart ${slot + 1} of 3.`),
        ...toolCallPart(`call_create_${slot}`, "create_chart_spec", { spec: specInput }),
      ],
      finishReason: "tool-calls",
    };
  }

  return {
    parts: textParts("Dashboard built: three charts are now on your dashboard."),
    finishReason: "stop",
  };
}

/**
 * A LanguageModelV4 implementation driven entirely by the script above.
 * `modelId` is `mock-scripted` so every persisted run is clearly labeled.
 */
export function createScriptedMockModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "graphite.mock",
    modelId: "mock-scripted",
    supportedUrls: {},
    async doStream(options: LanguageModelV4CallOptions) {
      const { parts, finishReason } = scriptNextResponse(options);
      const state = readScriptState(options);
      const delayMs = state.testFlag === "slow_run" ? 250 : 0;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          const emit = async (part: LanguageModelV4StreamPart): Promise<void> => {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            controller.enqueue(part);
          };
          await emit({ type: "stream-start", warnings: [] });
          await emit({
            type: "response-metadata",
            id: `mock-${Date.now()}`,
            modelId: "mock-scripted",
          });
          for (const part of parts) await emit(part);
          await emit({
            type: "finish",
            usage: MOCK_USAGE,
            finishReason: { unified: finishReason, raw: finishReason },
          });
          controller.close();
        },
      });
      return {
        stream,
        request: { body: null },
      };
    },
    async doGenerate(options: LanguageModelV4CallOptions) {
      const { parts, finishReason } = scriptNextResponse(options);
      const content = parts.filter(
        (p): p is Extract<LanguageModelV4StreamPart, { type: "text-delta" }> => p.type === "text-delta",
      );
      const toolCalls = parts.filter(
        (p): p is Extract<LanguageModelV4StreamPart, { type: "tool-call" }> => p.type === "tool-call",
      );
      return {
        content: [
          ...content.map((c) => ({ type: "text" as const, text: c.delta })),
          ...toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            input: c.input,
          })),
        ],
        finishReason: { unified: finishReason, raw: finishReason },
        usage: MOCK_USAGE,
        warnings: [],
        request: { body: null },
        response: { id: `mock-${Date.now()}`, modelId: "mock-scripted" },
      };
    },
  };
}
