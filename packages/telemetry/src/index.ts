import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { diag, DiagConsoleLogger, DiagLogLevel, trace, context, propagation, type Span } from "@opentelemetry/api";

/**
 * OpenTelemetry for api, worker, and the data service (Phase 8).
 *
 * Enabled only when OTEL_ENABLED=true; otherwise nothing is started and the
 * API surface degrades to a no-op tracer, so tests and local dev pay no
 * overhead. Trace context flows through HTTP and gRPC automatically via the
 * auto-instrumentations; BullMQ job data carries it explicitly (inject /
 * extract helpers below).
 */

let started = false;

export interface TelemetryOptions {
  serviceName: string;
  /** Base URL of the OTLP HTTP endpoint, e.g. http://localhost:4318. */
  otlpEndpoint?: string;
  logLevel?: "none" | "info" | "debug";
}

export function startTelemetry(opts: TelemetryOptions): boolean {
  if (started) return false;
  if (process.env.OTEL_ENABLED !== "true") return false;
  // Metrics are pulled by Prometheus from each process's /metrics endpoint;
  // disable the OTLP metric push so the collector needs no metrics pipeline.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  const endpoint = opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  if (opts.logLevel === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  } else if (opts.logLevel !== "none") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }
  const sdk = new NodeSDK({
    serviceName: opts.serviceName,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Keep instrumentation focused and cheap: http, grpc, express,
        // ioredis cover our propagation paths. fs is noise.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  started = true;
  return true;
}

export function telemetryStarted(): boolean {
  return started;
}

export { trace, context, propagation };

/** Current trace id ("" when tracing is off). */
export function currentTraceId(): string {
  const span = trace.getSpan(context.active());
  const id = span?.spanContext().traceId;
  return id && /^0+$/.test(id) === false ? id : "";
}

/**
 * Inject the active trace context into a plain object (BullMQ job data) as
 * W3C traceparent/tracestate carriers.
 */
export function injectTraceContext(carrier: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Extract a context previously stored by injectTraceContext. */
export function extractTraceContext(carrier: Record<string, string> | undefined): ReturnType<typeof context.active> {
  if (!carrier) return context.active();
  return propagation.extract(context.active(), carrier);
}

/**
 * Start a span as a child of `parentCtx` and return it with its context.
 * Works both with tracing enabled (real spans) and disabled (non-recording).
 */
export function startSpanFor(
  parentCtx: ReturnType<typeof context.active> | undefined,
  name: string,
  attributes?: Record<string, string | number | boolean>,
): { span: Span; ctx: ReturnType<typeof context.active> } {
  const tracer = trace.getTracer("graphite");
  const span = tracer.startSpan(name, { attributes }, parentCtx ?? context.active());
  return { span, ctx: trace.setSpan(parentCtx ?? context.active(), span) };
}

/** Run an async function inside a span; ends the span and records errors. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const { span, ctx } = startSpanFor(context.active(), name, attributes);
  try {
    return await context.with(ctx, fn);
  } catch (e) {
    span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: e instanceof Error ? e.message : "error" });
    throw e;
  } finally {
    span.end();
  }
}
