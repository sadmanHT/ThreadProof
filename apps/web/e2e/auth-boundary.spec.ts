import { expect, test } from "@playwright/test";

test.describe("public authentication boundary", () => {
  test("renders consortium access and trust-boundary messaging", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Private commercial data. Shared cryptographic certainty." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to ThreadProof" })).toBeVisible();
    await expect(page.getByText("Permissions are enforced by Supabase RLS; production authorization remains anchored to the consortium chain.")).toBeVisible();
    await expect(page.getByText("The application coordinates workflows. It cannot declare capacity, credentials, or governance actions canonical.")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("preserves a same-origin application redirect target", async ({ page }) => {
    await page.goto("/login?next=%2Fapp%2Forders%3Fview%3Dpending%23latest");

    await expect(page.locator('input[name="next"]')).toHaveValue("/app/orders?view=pending#latest");
  });

  for (const unsafeTarget of [
    "https://example.invalid/steal",
    "//example.invalid/steal",
    "/\\example.invalid/steal",
  ]) {
    test(`rejects unsafe redirect target ${JSON.stringify(unsafeTarget)}`, async ({ page }) => {
      await page.goto(`/login?next=${encodeURIComponent(unsafeTarget)}`);

      await expect(page.locator('input[name="next"]')).toHaveValue("/app");
    });
  }

  test("auth callback failure never reflects an unsafe next target", async ({ page }) => {
    await page.goto(`/auth/callback?next=${encodeURIComponent("//example.invalid/steal")}`);

    await expect(page).toHaveURL(/\/login\?error=Unable\+to\+complete\+sign\+in\.$/);
    await expect(page.locator('input[name="next"]')).toHaveValue("/app");
  });
});
