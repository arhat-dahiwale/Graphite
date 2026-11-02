import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Suites share one test database and Redis DB; they must not interleave.
    fileParallelism: false,
  },
});
