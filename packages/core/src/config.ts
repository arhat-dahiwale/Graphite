import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

/**
 * Load the nearest `.env` walking up from cwd (the repo root in practice).
 * Call once at process start, before parseEnv. Note: this module is NOT
 * re-exported from the core barrel so that browser bundles never pull in dotenv.
 */
export function loadRootEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, quiet: true });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Parse and validate process environment with a Zod schema. Apps call this
 * once at boot with their own schema so misconfiguration fails loudly.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: unknown = process.env,
): z.output<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export const coreEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export type CoreEnv = z.output<typeof coreEnvSchema>;

export const adminEnvSchema = coreEnvSchema.extend({
  DATABASE_ADMIN_URL: z.string().min(1),
});

export const limitsSchema = z.object({
  MAX_UPLOAD_MB: z.coerce.number().int().default(50),
  MAX_QUERY_ROWS: z.coerce.number().int().default(5000),
  STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(10_000),
  AGENT_TOKEN_BUDGET: z.coerce.number().int().default(200_000),
  AGENT_RUN_CONCURRENCY: z.coerce.number().int().default(2),
});

export type LimitsEnv = z.output<typeof limitsSchema>;

/**
 * Browser origins allowed to call the API (Express CORS and the Socket.IO
 * server). Credentials are enabled, so a wildcard "*" is rejected: callers
 * must list explicit origins, comma-separated, via CORS_ORIGINS.
 */
export const DEFAULT_CORS_ORIGINS: readonly string[] = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [...DEFAULT_CORS_ORIGINS];
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (origins.includes("*")) {
    throw new Error(
      "CORS_ORIGINS cannot contain '*': credentials are enabled, list explicit origins " +
        "(e.g. http://localhost:3000,https://app.example.com).",
    );
  }
  if (origins.length === 0) {
    throw new Error("CORS_ORIGINS is set but empty after parsing; list explicit origins.");
  }
  return origins;
}
