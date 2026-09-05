import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { installDisposableTestWallet } from "./helpers/test-wallet";

const enabled = process.env.THREADPROOF_BROWSER_CHAIN_E2E === "true";
const demoPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const buyerPrivateKey = process.env.THREADPROOF_E2E_BUYER_PRIVATE_KEY as Hex | undefined;
const rpcUrl = process.env.THREADPROOF_RPC_URL;
const orderRegistryAddress = process.env.THREADPROOF_ORDER_REGISTRY_ADDRESS as Address | undefined;
const registryAddress = process.env.THREADPROOF_REGISTRY_ADDRESS as Address | undefined;
const runId = process.env.THREADPROOF_BROWSER_E2E_RUN_ID;
const sourceSha = process.env.THREADPROOF_SOURCE_SHA;
const chainId = Number(process.env.THREADPROOF_CHAIN_ID ?? 0);

const POLICY_HASH = `0x${"99".repeat(32)}` as Hex;
const BUYER_CHAIN_ID = `0x${"aa".repeat(32)}` as Hex;
const FACTORY_CHAIN_ID = `0x${"bb".repeat(32)}` as Hex;

const orderRegistryAbi = parseAbi([
  "function getOrder(bytes32 orderId) view returns ((bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 currentVersion,bytes32 currentVersionHash,uint256 currentOrderCommitment,bytes32 currentPolicyHash,uint64 updatedAt,uint8 status))",
]);
const registryAbi = parseAbi([
  "function organizationOfAccount(address account) view returns (bytes32)",
  "function isActiveAccount(address account) view returns (bool)",
]);

function requiredConfiguration() {
  return Boolean(
    demoPassword &&
    serviceRoleKey &&
    supabaseUrl &&
    buyerPrivateKey &&
    rpcUrl &&
    orderRegistryAddress &&
    registryAddress &&
    runId &&
    sourceSha &&
    chainId === 2026,
  );
}

async function loginBuyer(page: Page) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill("buyer.demo@threadproof.test");
  await page.getByLabel("Password").fill(demoPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(?:\?.*)?$/, { timeout: 15_000 });
}

async function createNamespacedDraft(page: Page, externalReference: string, title: string) {
  await page.goto("/app/orders/new");
  await expect(page.getByRole("heading", { name: "Counterparties" })).toBeVisible();
  await page.getByLabel("Primary factory").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Order details" })).toBeVisible();
  await page.getByLabel("External reference").fill(externalReference);
  await page.getByLabel("Order title").fill(title);
  await page.getByLabel("Product or style category").fill("Browser-chain integration garment");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Quantity & delivery" })).toBeVisible();
  await page.getByLabel("Quantity").fill("1250");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await page.getByRole("button", { name: "Create private draft" }).click();
  await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]{36}(?:\?.*)?$/i, { timeout: 20_000 });
  return page.url().match(/\/app\/orders\/([0-9a-f-]{36})/i)?.[1] ?? null;
}

test.describe("authenticated browser-to-chain order authorization", () => {
  test.skip(!enabled, "Disposable browser-to-chain integration runs only in its dedicated workflow.");

  test("buyer wallet authorization becomes canonical OrderRegistry state and reconciled UI evidence", async ({ page }) => {
    test.setTimeout(150_000);
    expect(requiredConfiguration(), "Dedicated browser-chain workflow is missing a required fail-closed runtime input.").toBe(true);

    const buyerAddress = await installDisposableTestWallet(page, {
      privateKey: buyerPrivateKey!,
      chainId,
    });
    await loginBuyer(page);

    const unique = Date.now().toString(36).toUpperCase();
    const externalReference = `E2E-CHAIN-${runId}-${unique}`;
    const title = `Browser to OrderRegistry ${unique}`;
    const orderId = await createNamespacedDraft(page, externalReference, title);
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    await page.getByLabel("Confidential workload").fill("540000");
    await page.getByLabel("Consortium policy hash").fill(POLICY_HASH);
    await page.getByRole("button", { name: "Sign version 1" }).click();
    await expect(page.getByText(/Signature validated against the on-chain buyer organization and queued for relay/)).toBeVisible({ timeout: 30_000 });

    const service = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    type Confirmation = {
      chain_tx_hash: string;
      chain_block_number: number;
      chain_order_id: string;
      current_order_commitment: string;
      current_policy_hash: string;
      version_hash: string;
      order_version_tx_hash: string;
      order_version_block: number;
    };

    let confirmation: Confirmation | null = null;
    await expect.poll(async () => {
      const { data: order, error: orderError } = await service
        .from("purchase_orders")
        .select("chain_order_id,current_version,current_order_commitment,current_policy_hash,status")
        .eq("id", orderId!)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order || order.current_version !== 1 || order.status !== "proposed") return "order-not-reconciled";

      const [{ data: job, error: jobError }, { data: version, error: versionError }] = await Promise.all([
        service
          .from("order_authorization_jobs")
          .select("status,chain_tx_hash,chain_block_number")
          .eq("purchase_order_id", orderId!)
          .eq("target_version", 1)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        service
          .from("order_versions")
          .select("version_hash,chain_tx_hash,chain_block_number,order_commitment,policy_hash")
          .eq("purchase_order_id", orderId!)
          .eq("version", 1)
          .maybeSingle(),
      ]);
      if (jobError) throw jobError;
      if (versionError) throw versionError;
      if (!job || job.status !== "confirmed" || !job.chain_tx_hash || !job.chain_block_number || !version) {
        return "authorization-not-confirmed";
      }
      if (!version.chain_tx_hash || !version.chain_block_number || !version.version_hash) return "version-evidence-incomplete";
      if (version.chain_tx_hash.toLowerCase() !== job.chain_tx_hash.toLowerCase()) return "tx-mismatch";
      if (BigInt(version.order_commitment) !== BigInt(order.current_order_commitment)) return "commitment-mismatch";
      if (version.policy_hash.toLowerCase() !== order.current_policy_hash.toLowerCase()) return "policy-mismatch";

      confirmation = {
        chain_tx_hash: job.chain_tx_hash,
        chain_block_number: job.chain_block_number,
        chain_order_id: order.chain_order_id,
        current_order_commitment: order.current_order_commitment,
        current_policy_hash: order.current_policy_hash,
        version_hash: version.version_hash,
        order_version_tx_hash: version.chain_tx_hash,
        order_version_block: version.chain_block_number,
      };
      return "confirmed";
    }, {
      message: "OrderRegistry event was not reconciled into the application read model.",
      timeout: 90_000,
      intervals: [1_000, 1_500, 2_000, 3_000],
    }).toBe("confirmed");

    expect(confirmation).not.toBeNull();
    const canonical = confirmation!;
    const publicClient = createPublicClient({ transport: http(rpcUrl!, { timeout: 8_000 }) });
    const [registeredBuyer, buyerActive, chainState] = await Promise.all([
      publicClient.readContract({ address: registryAddress!, abi: registryAbi, functionName: "organizationOfAccount", args: [buyerAddress] }),
      publicClient.readContract({ address: registryAddress!, abi: registryAbi, functionName: "isActiveAccount", args: [buyerAddress] }),
      publicClient.readContract({ address: orderRegistryAddress!, abi: orderRegistryAbi, functionName: "getOrder", args: [canonical.chain_order_id as Hex] }),
    ]);

    expect(buyerActive).toBe(true);
    expect(registeredBuyer.toLowerCase()).toBe(BUYER_CHAIN_ID.toLowerCase());
    expect(chainState.buyerOrganizationId.toLowerCase()).toBe(BUYER_CHAIN_ID.toLowerCase());
    expect(chainState.primaryFactoryOrganizationId.toLowerCase()).toBe(FACTORY_CHAIN_ID.toLowerCase());
    expect(chainState.currentVersion).toBe(1);
    expect(chainState.currentVersionHash.toLowerCase()).toBe(canonical.version_hash.toLowerCase());
    expect(chainState.currentOrderCommitment).toBe(BigInt(canonical.current_order_commitment));
    expect(chainState.currentPolicyHash.toLowerCase()).toBe(POLICY_HASH.toLowerCase());
    expect(chainState.status).toBe(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Version 1 canonical", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Version 1 anchored" })).toBeVisible();
    await expect(page.locator(`a[href="/app/chain/transactions/${canonical.chain_tx_hash}"]`).first()).toBeVisible();

    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/browser-chain-order-evidence.json", `${JSON.stringify({
      schemaVersion: 1,
      evidenceClass: "disposable-browser-integration",
      productionEvidence: false,
      sourceSha,
      chainId,
      buyer: {
        organizationId: BUYER_CHAIN_ID,
        signer: buyerAddress,
        activeOnChain: buyerActive,
      },
      factoryOrganizationId: FACTORY_CHAIN_ID,
      applicationOrderId: orderId,
      chainOrderId: canonical.chain_order_id,
      version: 1,
      versionHash: canonical.version_hash,
      orderCommitment: canonical.current_order_commitment,
      policyHash: canonical.current_policy_hash,
      transactionHash: canonical.chain_tx_hash,
      blockNumber: canonical.chain_block_number,
      applicationReconciled: true,
      browserRenderedCanonicalVersion: true,
    }, null, 2)}\n`, "utf8");
  });
});
