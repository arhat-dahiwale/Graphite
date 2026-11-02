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
