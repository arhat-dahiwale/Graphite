import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createScriptedMockModel } from "./mock-model.js";

export type GraphiteModel = LanguageModelV4;

export type ProviderName = "mock" | "anthropic";

/**
 * Provider config: LLM_PROVIDER selects the model behind the exact same agent
 * pipeline. `mock` (default when no provider key is set) uses the deterministic
 * scripted model; `anthropic` requires ANTHROPIC_API_KEY.
 */
export function resolveProviderName(env: {
  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
}): ProviderName {
  const p = env.LLM_PROVIDER?.trim().toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "mock") return "mock";
  // Default: mock unless a real key is present.
  return env.ANTHROPIC_API_KEY ? "anthropic" : "mock";
}

export function createModel(env: {
  LLM_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
}): { model: GraphiteModel; provider: ProviderName; modelId: string } {
  const provider = resolveProviderName(env);
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
    }
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const modelId = env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
    return { model: anthropic.languageModel(modelId) as unknown as GraphiteModel, provider, modelId };
  }
  return { model: createScriptedMockModel(), provider: "mock", modelId: "mock-scripted" };
}
