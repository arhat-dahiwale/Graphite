import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Critical user flow (Phase 9): sign-up -> org -> project -> upload CSV ->
 * dashboard -> mock agent run -> charts appear. Uses the deterministic
 * mock-scripted model, so the run is stable in CI and locally.
 */

const EMAIL = `e2e-${Date.now()}@test.example`;
const PASSWORD = "password12345";

let projectDir: string;
let csvPath: string;

test.beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "graphite-e2e-"));
  csvPath = join(projectDir, "sales.csv");
  const rows = ["region,revenue"];
  const regions = ["north", "south", "east", "west"];
  for (let i = 0; i < 60; i++) {
    rows.push(`${regions[i % 4]},${(i * 37) % 500 + 10}`);
  }
  writeFileSync(csvPath, rows.join("\n"));
});

test("sign-up through agent-built dashboard", async ({ page }) => {
  // 1. Sign up.
  await page.goto("/signup");
  await page.getByRole("textbox", { name: "Name" }).fill("E2E Tester");
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  await page.getByRole("textbox", { name: "Password (8+ characters)" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();

  // 2. First-run: create the organization.
  await expect(page.getByRole("heading", { name: /Create your (first )?organization/i })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Organization name" }).fill("E2E Org");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Projects in E2E Org/i })).toBeVisible();

  // 3. Create a project, then open it.
  await page.getByRole("textbox", { name: "New project name" }).fill("E2E Project");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("link", { name: "E2E Project" }).click();
  await page.getByRole("heading", { name: /Datasets/i }).waitFor();

  // 4. Upload the CSV and wait for ingestion (the list page has no live
  // progress, so poll with reloads).
  await page.locator('input[type="file"]').setInputFiles(csvPath);
  await expect(page.getByText("sales.csv").first()).toBeVisible();
  // Poll with reloads; the inner expect retries within each window so the
  // post-reload data fetch is not raced by the count.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("ready", { exact: true }).first()).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 120_000 });

  // 5. Create a dashboard, then open it.
  await page.getByRole("textbox", { name: "New dashboard name" }).fill("E2E Dash");
  await page.getByRole("button", { name: "Create dashboard" }).click();
  await page.getByRole("link", { name: "E2E Dash" }).click();
  await page.getByRole("heading", { name: /E2E Dash/i }).waitFor();

  // 6. Mock agent run: ask for a dashboard.
  await page.getByPlaceholder(/Build a dashboard/i).fill("Build a dashboard from the sales data.");
  await page.getByRole("button", { name: /Build dashboard/i }).click();

  // 7. The run succeeds (mock-scripted badge) and charts appear on the canvas.
  await expect(page.getByText("mock-scripted").first()).toBeVisible();
  await expect(
    page.locator("canvas").first(),
  ).toBeVisible({ timeout: 120_000 });
  // At least 3 agent charts arrive for the scripted run; wait for the third.
  await expect(page.getByText(/v1 · agent/i)).toHaveCount(3, { timeout: 120_000 });
});
