import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against the dev stack (web :3000 + api :4000 + worker + data
 * + Postgres/Redis/MinIO). Start it with `pnpm dev` first; locally the config
 * reuses a running server, in CI it starts `pnpm dev` itself.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_REUSE
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
