import { z } from "zod";
import { limitsSchema, parseEnv, loadRootEnv } from "@graphite/core/config";

export const envSchema = limitsSchema
  .extend({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    DATABASE_ADMIN_URL: z.string().min(1).optional(),
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().default("http://localhost:4000"),
    WEB_URL: z.string().default("http://localhost:3000"),
    API_PORT: z.coerce.number().int().default(4000),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    S3_ENDPOINT: z.string().default("http://localhost:9000"),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
    S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
    S3_BUCKET: z.string().default("graphite-uploads"),
    S3_FORCE_PATH_STYLE: z
      .string()
      .default("true")
      .transform((v) => v !== "false"),
    DATA_GRPC_HOST: z.string().default("127.0.0.1"),
    DATA_GRPC_PORT: z.coerce.number().int().default(50051),
    WORKER_INTERNAL_MCP_URL: z.string().default("http://127.0.0.1:4100"),
    // Comma-separated explicit browser origins for CORS and Socket.IO.
    // "*" is rejected: credentials (cookies) are always enabled.
    CORS_ORIGINS: z
      .string()
      .refine(
        (v) => !v.split(",").map((s) => s.trim()).includes("*"),
        { message: "CORS_ORIGINS cannot contain '*' (credentials are enabled)" },
      )
      .optional(),
    // Signs/verifies the internal MCP identity headers when the API mounts MCP.
    INTERNAL_MCP_SECRET: z.string().min(32).optional(),
  });

export type Env = z.output<typeof envSchema>;

// .env must be loaded before parsing; imports may only rely on `env` afterwards.
loadRootEnv();

export const env = parseEnv(envSchema);
