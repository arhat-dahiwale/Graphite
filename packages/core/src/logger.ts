import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * Structured JSON logger. Redacts secrets and never logs raw CSV data.
 * Child loggers should carry component/request identifiers as bindings.
 */
export const logger = pino({
  level,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "*.token",
      "*.password",
      "*.apiKey",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
