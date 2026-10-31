import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_ADMIN_URL ?? "postgres://graphite:graphite@localhost:5432/graphite",
  },
  strict: true,
});
