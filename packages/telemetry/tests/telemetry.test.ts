import { describe, expect, it } from "vitest";
import { parseAllowedOrigins } from "@graphite/core/config";
import {
  currentTraceId,
  extractTraceContext,
  injectTraceContext,
  startSpanFor,
  startTelemetry,
  withSpan,
} from "../src/index";
import { renderMetrics } from "../src/metrics";

describe("telemetry helpers (tracing off)", () => {
  it("startTelemetry is a no-op unless OTEL_ENABLED=true", () => {
    expect(startTelemetry({ serviceName: "test-off" })).toBe(false);
    expect(currentTraceId()).toBe("");
  });

  it("withSpan runs the function and returns its value without a tracer", async () => {
    const v = await withSpan("test.span", { a: 1 }, async () => 42);
    expect(v).toBe(42);
  });

  it("withSpan propagates thrown errors", async () => {
    await expect(
      withSpan("test.span.fail", undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("trace context inject/extract round-trips (inactive context)", () => {
    const carrier = injectTraceContext({});
    const ctx = extractTraceContext(carrier);
    expect(ctx).toBeDefined();
  });

  it("startSpanFor returns a span and context", () => {
    const { span, ctx } = startSpanFor(undefined, "test.span2");
    expect(span).toBeDefined();
    expect(ctx).toBeDefined();
    span.end();
  });

  it("renderMetrics returns prometheus text", async () => {
    const text = await renderMetrics();
    expect(text).toContain("graphite_http_request_duration_seconds");
    expect(text).toContain("graphite_agent_run_duration_seconds");
    expect(text).toContain("graphite_agent_tokens_total");
    expect(text).toContain("graphite_websocket_connections");
  });
});

describe("CORS origin parsing (shared config)", () => {
  it("rejects wildcards", () => {
    expect(() => parseAllowedOrigins("*")).toThrow();
  });
});
