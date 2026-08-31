import { expect, test, type Page } from "@playwright/test";

const demoPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const hostedSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    demoPassword,
);

async function login(page: Page, email: string) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(demoPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(?:\?.*)?$/, { timeout: 15_000 });
}

test.describe("authenticated role workspaces", () => {
  test.skip(!hostedSupabaseConfigured, "Hosted Supabase E2E credentials are not configured.");

  test("buyer reaches the RLS-scoped order workspace and proof evidence", async ({ page }) => {
    await login(page, "buyer.demo@threadproof.test");

    await expect(page.locator("main").getByText("Demo Buyer", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authorize production without asking factories to reveal capacity." })).toBeVisible();
    await expect(page.getByText("DEMO-PO-002", { exact: false })).toBeVisible();

    await page.goto("/app/proofs/80000000-0000-4000-8000-000000000001");
    await expect(page.getByRole("heading", { name: "Demo feasible order · 30,000 shirts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "The witness is not on this page." })).toBeVisible();
    await expect(page.getByText("Witness concealed", { exact: true })).toBeVisible();
  });

  test("factory reaches its private capacity and proof workspace", async ({ page }) => {
    await login(page, "factory.demo@threadproof.test");

    await expect(page.locator("main").getByText("Demo Factory", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Spend certified capacity privately and exactly once." })).toBeVisible();
    await expect(page.getByText("DEMO-2026-Q4", { exact: false })).toBeVisible();
    await expect(page.getByText("Proofs in progress", { exact: true })).toBeVisible();
  });

  test("auditor reaches certification work without order visibility", async ({ page }) => {
    await login(page, "auditor.demo@threadproof.test");

    await expect(page.locator("main").getByText("Demo Auditor", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Certify the commitment, not a public capacity number." })).toBeVisible();
    await expect(page.getByText("DEMO-2027-Q1", { exact: false })).toBeVisible();
    await expect(page.getByText("Certification in progress", { exact: true })).toBeVisible();
  });

  test("governance participant reaches Charter due-process state", async ({ page }) => {
    await login(page, "governance.demo@threadproof.test");

    await expect(page.locator("main").getByText("Demo Regulator", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exercise exceptional powers through attributable due process." })).toBeVisible();
    await expect(page.getByText("Pending / timelocked", { exact: true })).toBeVisible();

    await page.goto("/app/governance");
    await expect(page.getByRole("heading", { name: "Governance" })).toBeVisible();
    await expect(page.getByText("DEMO-9002", { exact: false })).toBeVisible();
  });
});
