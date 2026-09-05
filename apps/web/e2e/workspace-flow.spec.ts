import { expect, test, type Page } from "@playwright/test";

const demoPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const hostedSupabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
    demoPassword,
);

async function login(page: Page, email = "buyer.demo@threadproof.test") {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(demoPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(?:\?.*)?$/, { timeout: 15_000 });
}

function collectRuntimeFailures(page: Page) {
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  return { pageErrors, serverErrors };
}

test.describe("smooth authenticated workspace flow", () => {
  test.skip(!hostedSupabaseConfigured, "Hosted Supabase E2E credentials are not configured.");

  test("workspace command palette supports keyboard search and navigation", async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await login(page);

    await page.getByRole("button", { name: "Search workspace" }).first().click();
    const search = page.getByRole("combobox", { name: "Search pages and workflows" });
    await expect(search).toBeFocused();
    await search.fill("orders");

    const ordersOption = page.getByRole("option", { name: /Orders/ });
    await expect(ordersOption).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/app\/orders$/);
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await expect(page.getByRole("dialog", { name: "Workspace search" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Workspace search" })).toBeHidden();

    expect(failures.pageErrors).toEqual([]);
    expect(failures.serverErrors).toEqual([]);
  });

  test("buyer workspace routes render without page or server failures", async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await login(page);

    const routes = [
      "/app",
      "/app/orders",
      "/app/proofs",
      "/app/credentials",
      "/app/subcontracts",
      "/app/organizations",
      "/app/governance",
      "/app/audit",
      "/app/chain",
      "/app/operations",
      "/app/intelligence",
      "/app/team",
      "/app/settings",
    ];

    for (const route of routes) {
      const response = await page.goto(route);
      expect(response, `navigation response for ${route}`).not.toBeNull();
      expect(response?.status(), `HTTP status for ${route}`).toBeLessThan(500);
      await expect(page.locator("main.app-main"), `workspace main for ${route}`).toBeVisible();
      await expect(page.getByText("Something went wrong", { exact: false })).toHaveCount(0);
    }

    expect(failures.pageErrors).toEqual([]);
    expect(failures.serverErrors).toEqual([]);
  });

  test("mobile workspace navigation remains usable without horizontal overflow", async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "Open navigation" }).click();
    const ordersLink = page.getByRole("link", { name: /Orders/ }).first();
    await expect(ordersLink).toBeVisible();
    await ordersLink.click();
    await expect(page).toHaveURL(/\/app\/orders$/);
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    const ordersOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(ordersOverflow).toBeLessThanOrEqual(1);
    expect(failures.pageErrors).toEqual([]);
    expect(failures.serverErrors).toEqual([]);
  });

  test("buyer can create, edit, and deliberately delete a private draft", async ({ page }) => {
    const failures = collectRuntimeFailures(page);
    const unique = Date.now().toString(36).toUpperCase();
    const externalReference = `E2E-${unique}`;
    const originalTitle = `E2E flow draft ${unique}`;
    const revisedTitle = `${originalTitle} revised`;
    let createdUrl: string | null = null;

    await login(page);

    try {
      await page.goto("/app/orders/new");
      await expect(page.getByRole("heading", { name: "Counterparties" })).toBeVisible();
      await page.getByLabel("Primary factory").selectOption({ index: 1 });
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Order details" })).toBeVisible();
      await page.getByLabel("External reference").fill(externalReference);
      await page.getByLabel("Order title").fill(originalTitle);
      await page.getByLabel("Product or style category").fill("E2E test garment");
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Quantity & delivery" })).toBeVisible();
      await page.getByLabel("Quantity").fill("1250");
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
      const createButton = page.getByRole("button", { name: "Create private draft" });
      await createButton.click();
      await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]{36}(?:\?.*)?$/i, { timeout: 15_000 });
      createdUrl = page.url().split("?")[0] ?? null;
      await expect(page.getByRole("heading", { name: originalTitle })).toBeVisible();

      const titleInput = page.getByLabel("Title");
      await titleInput.fill(revisedTitle);
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(page.getByText("Draft updated.", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: revisedTitle })).toBeVisible();

      const deleteButton = page.getByRole("button", { name: "Delete draft" });
      await deleteButton.click();
      await expect(page.getByRole("button", { name: "Confirm delete" })).toBeVisible();
      expect(page.url().split("?")[0]).toBe(createdUrl);

      await page.getByRole("button", { name: "Confirm delete" }).click();
      await expect(page).toHaveURL(/\/app\/orders\?message=/, { timeout: 15_000 });
      await expect(page.getByText("Draft deleted.", { exact: true })).toBeVisible();
      createdUrl = null;
    } finally {
      if (createdUrl) {
        try {
          await page.goto(createdUrl);
          const deleteButton = page.getByRole("button", { name: "Delete draft" });
          if (await deleteButton.isVisible({ timeout: 1500 }).catch(() => false)) {
            await deleteButton.click();
            const confirmButton = page.getByRole("button", { name: "Confirm delete" });
            if (await confirmButton.isVisible({ timeout: 1000 }).catch(() => false)) {
              await confirmButton.click();
              await page.waitForURL(/\/app\/orders(?:\?.*)?$/, { timeout: 5000 }).catch(() => undefined);
            }
          }
        } catch {
          // Best-effort cleanup must not hide the original browser-flow assertion.
        }
      }
    }

    expect(failures.pageErrors).toEqual([]);
    expect(failures.serverErrors).toEqual([]);
  });
});
