import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installDisposableTestWallet } from "./helpers/test-wallet";

const enabled = process.env.THREADPROOF_BROWSER_CHAIN_E2E === "true";
const demoPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
const buyerPrivateKey = process.env.THREADPROOF_E2E_BUYER_PRIVATE_KEY as Hex | undefined;
const factoryPrivateKey = process.env.THREADPROOF_E2E_FACTORY_PRIVATE_KEY as Hex | undefined;
const auditorPrivateKey = process.env.THREADPROOF_E2E_AUDITOR_PRIVATE_KEY as Hex | undefined;
const rpcUrl = process.env.THREADPROOF_RPC_URL;
const capacityVaultAddress = process.env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address | undefined;
const runId = process.env.THREADPROOF_BROWSER_E2E_RUN_ID;
const sourceSha = process.env.THREADPROOF_SOURCE_SHA;
const chainId = Number(process.env.THREADPROOF_CHAIN_ID ?? 0);

const POLICY_HASH = `0x${"99".repeat(32)}` as Hex;
const FACTORY_CHAIN_ID = `0x${"bb".repeat(32)}` as Hex;
const UINT64_CAPACITY = "1800000";
const ORDER_WORKLOAD = "540000";

const capacityVaultAbi = parseAbi([
  "function getCapacityState(bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId) view returns ((uint256 activeCommitment,bytes32 capacityCredentialId,bytes32 policyHash,uint32 circuitVersion,uint64 updatedAt,bool active))",
  "function getVerifierProvenance(uint32 circuitVersion) view returns ((address verifier,bytes32 circuitArtifactHash,bytes32 verificationKeyHash,bytes32 verifierCodeHash,uint64 registeredAt))",
  "function usedNullifiers(uint256 nullifier) view returns (bool)",
  "function spendCapacity((bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,bytes32 orderId,bytes32 policyHash,uint256 oldCapacityCommitment,uint256 newCapacityCommitment,uint256 orderCommitment,uint256 nullifier,uint32 circuitVersion) request,uint256[2] a,uint256[2][2] b,uint256[2] c)",
  "error StaleCapacityState(uint256 expected,uint256 supplied)",
  "error NullifierAlreadyUsed(uint256 nullifier)",
]);

function requiredConfiguration() {
  return Boolean(
    demoPassword &&
    serviceRoleKey &&
    supabaseUrl &&
    buyerPrivateKey &&
    factoryPrivateKey &&
    auditorPrivateKey &&
    rpcUrl &&
    capacityVaultAddress &&
    runId &&
    sourceSha &&
    chainId === 2026,
  );
}

async function login(page: Page, email: string) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(demoPassword ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app(?:\?.*)?$/, { timeout: 15_000 });
}

async function createNamespacedDraft(page: Page, externalReference: string, title: string) {
  await page.goto("/app/orders/new");
  await expect(page.getByRole("heading", { name: "Counterparties" })).toBeVisible();
  await page.getByLabel("Primary factory").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("External reference").fill(externalReference);
  await page.getByLabel("Order title").fill(title);
  await page.getByLabel("Product or style category").fill("Stage 2 browser Groth16 garment");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Quantity").fill("1250");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create private draft" }).click();
  await expect(page).toHaveURL(/\/app\/orders\/[0-9a-f-]{36}(?:\?.*)?$/i, { timeout: 20_000 });
  return page.url().match(/\/app\/orders\/([0-9a-f-]{36})/i)?.[1] ?? null;
}

function dateInput(daysFromToday: number) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + daysFromToday);
  return value.toISOString().slice(0, 10);
}

function proofCalldata(proof: Record<string, unknown>) {
  const piA = proof.pi_a as unknown[] | undefined;
  const piB = proof.pi_b as unknown[][] | undefined;
  const piC = proof.pi_c as unknown[] | undefined;
  if (!piA?.[0] || !piA?.[1] || !piB?.[0]?.[0] || !piB?.[0]?.[1] || !piB?.[1]?.[0] || !piB?.[1]?.[1] || !piC?.[0] || !piC?.[1]) {
    throw new Error("Stored browser-chain Groth16 proof is malformed");
  }
  return {
    a: [BigInt(String(piA[0])), BigInt(String(piA[1]))] as [bigint, bigint],
    b: [
      [BigInt(String(piB[0][1])), BigInt(String(piB[0][0]))],
      [BigInt(String(piB[1][1])), BigInt(String(piB[1][0]))],
    ] as [[bigint, bigint], [bigint, bigint]],
    c: [BigInt(String(piC[0])), BigInt(String(piC[1]))] as [bigint, bigint],
  };
}

test.describe("authenticated browser-to-chain real PoFC", () => {
  test.skip(!enabled, "Disposable browser-to-chain integration runs only in its dedicated workflow.");

  test("auditor browser certification and factory proof queue advance real Groth16 capacity exactly once", async ({ browser }) => {
    test.setTimeout(300_000);
    expect(requiredConfiguration(), "Stage 2 browser-chain workflow is missing a required fail-closed runtime input.").toBe(true);

    const service = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const publicClient = createPublicClient({ transport: http(rpcUrl!, { timeout: 8_000 }) });
    const unique = Date.now().toString(36).toUpperCase();
    const externalReference = `E2E-CHAIN-${runId}-POFC-${unique}`;
    const title = `Browser Groth16 PoFC ${unique}`;
    const periodLabel = `E2E-CHAIN-${runId}-POFC-PERIOD-${unique}`;
    const processLabel = "SEWING";

    const buyerContext = await browser.newContext({ baseURL: appUrl });
    const buyerPage = await buyerContext.newPage();
    const buyerAddress = await installDisposableTestWallet(buyerPage, {
      privateKey: buyerPrivateKey!,
      chainId,
      rpcUrl,
    });
    await login(buyerPage, "buyer.demo@threadproof.test");
    const purchaseOrderId = await createNamespacedDraft(buyerPage, externalReference, title);
    expect(purchaseOrderId).toMatch(/^[0-9a-f-]{36}$/i);
    await buyerPage.getByLabel("Confidential workload").fill(ORDER_WORKLOAD);
    await buyerPage.getByLabel("Consortium policy hash").fill(POLICY_HASH);
    await buyerPage.getByRole("button", { name: "Sign version 1" }).click();
    await expect(buyerPage.getByText(/Signature validated against the on-chain buyer organization and queued for relay/)).toBeVisible({ timeout: 30_000 });

    let orderContext: {
      orderVersionId: string;
      chainOrderId: Hex;
      factoryOrganizationId: string;
      orderCommitment: string;
      orderTxHash: string;
      orderBlock: number;
    } | null = null;
    await expect.poll(async () => {
      const { data: order, error: orderError } = await service
        .from("purchase_orders")
        .select("id,factory_organization_id,chain_order_id,current_version,current_order_commitment,current_policy_hash,status")
        .eq("id", purchaseOrderId!)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order || order.current_version !== 1 || order.status !== "proposed" || !order.chain_order_id) return "order-pending";
      const { data: version, error: versionError } = await service
        .from("order_versions")
        .select("id,chain_tx_hash,chain_block_number,order_commitment,policy_hash")
        .eq("purchase_order_id", purchaseOrderId!)
        .eq("version", 1)
        .maybeSingle();
      if (versionError) throw versionError;
      if (!version?.chain_tx_hash || !version.chain_block_number) return "version-pending";
      if (version.policy_hash.toLowerCase() !== POLICY_HASH.toLowerCase()) return "policy-mismatch";
      orderContext = {
        orderVersionId: version.id,
        chainOrderId: order.chain_order_id as Hex,
        factoryOrganizationId: order.factory_organization_id,
        orderCommitment: version.order_commitment,
        orderTxHash: version.chain_tx_hash,
        orderBlock: version.chain_block_number,
      };
      return "confirmed";
    }, { timeout: 90_000, intervals: [1_000, 1_500, 2_000, 3_000] }).toBe("confirmed");
    await buyerContext.close();
    expect(orderContext).not.toBeNull();
    const anchoredOrder = orderContext!;

    const auditorContext = await browser.newContext({ baseURL: appUrl });
    const auditorPage = await auditorContext.newPage();
    const auditorAddress = await installDisposableTestWallet(auditorPage, {
      privateKey: auditorPrivateKey!,
      chainId,
      rpcUrl,
    });
    await login(auditorPage, "auditor.demo@threadproof.test");
    await auditorPage.goto("/app/capacity");
    await expect(auditorPage.getByRole("heading", { name: "Certify a private capacity opening" })).toBeVisible();
    await auditorPage.getByLabel("Factory").selectOption(anchoredOrder.factoryOrganizationId);
    await auditorPage.getByLabel("Exact certified capacity").fill(UINT64_CAPACITY);
    await auditorPage.getByLabel("Period label").fill(periodLabel);
    await auditorPage.getByLabel("Process label").fill(processLabel);
    await auditorPage.getByLabel("Consortium policy hash").fill(POLICY_HASH);
    await auditorPage.getByLabel("Assessment methodology").fill("Disposable Stage 2 browser-chain certification bound to real Groth16 PoFC.");
    await auditorPage.getByLabel("Valid from").fill(dateInput(0));
    await auditorPage.getByLabel("Valid until").fill(dateInput(30));
    await auditorPage.getByLabel("Circuit version").fill("1");
    await auditorPage.getByRole("button", { name: "Issue credential and certify" }).click();
    await expect(auditorPage.getByRole("status")).toContainText("Both transactions are mined", { timeout: 60_000 });

    let certification: {
      jobId: string;
      openingId: string;
      capacityCredentialId: string;
      chainCredentialId: Hex;
      chainPeriodId: Hex;
      chainProcessId: Hex;
      oldCommitment: string;
      credentialTxHash: string;
      credentialBlock: number;
      certificationTxHash: string;
      certificationBlock: number;
    } | null = null;
    await expect.poll(async () => {
      const { data: job, error: jobError } = await service
        .from("capacity_certification_jobs")
        .select("id,status,chain_credential_id,chain_period_id,chain_process_id,capacity_commitment,credential_tx_hash,credential_block_number,certification_tx_hash,certification_block_number,error_code,error_detail")
        .eq("factory_organization_id", anchoredOrder.factoryOrganizationId)
        .eq("period_label", periodLabel)
        .eq("process_label", processLabel)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) return "job-pending";
      if (job.status === "failed") throw new Error(`Capacity certification failed: ${job.error_code ?? "unknown"} ${job.error_detail ?? ""}`);
      if (job.status !== "confirmed") return `job-${job.status}`;
      const { data: opening, error: openingError } = await service
        .from("private_capacity_openings")
        .select("id,capacity_credential_id,capacity_commitment,chain_period_id,chain_process_id,status")
        .eq("factory_organization_id", anchoredOrder.factoryOrganizationId)
        .eq("period_id", periodLabel)
        .eq("process_id", processLabel)
        .maybeSingle();
      if (openingError) throw openingError;
      if (!opening || opening.status !== "active") return "opening-pending";
      const { data: credential, error: credentialError } = await service
        .from("credentials")
        .select("id,chain_credential_id,status")
        .eq("id", opening.capacity_credential_id)
        .maybeSingle();
      if (credentialError) throw credentialError;
      if (!credential?.chain_credential_id || credential.status !== "active") return "credential-pending";
      if (!job.credential_tx_hash || !job.credential_block_number || !job.certification_tx_hash || !job.certification_block_number) return "tx-evidence-pending";
      certification = {
        jobId: job.id,
        openingId: opening.id,
        capacityCredentialId: opening.capacity_credential_id,
        chainCredentialId: credential.chain_credential_id as Hex,
        chainPeriodId: opening.chain_period_id as Hex,
        chainProcessId: opening.chain_process_id as Hex,
        oldCommitment: opening.capacity_commitment,
        credentialTxHash: job.credential_tx_hash,
        credentialBlock: job.credential_block_number,
        certificationTxHash: job.certification_tx_hash,
        certificationBlock: job.certification_block_number,
      };
      return "confirmed";
    }, { timeout: 90_000, intervals: [1_000, 1_500, 2_000, 3_000] }).toBe("confirmed");
    await auditorContext.close();
    expect(certification).not.toBeNull();
    const certified = certification!;

    const factoryContext = await browser.newContext({ baseURL: appUrl });
    const factoryPage = await factoryContext.newPage();
    const factoryAddress = await installDisposableTestWallet(factoryPage, {
      privateKey: factoryPrivateKey!,
      chainId,
      rpcUrl,
    });
    await login(factoryPage, "factory.demo@threadproof.test");
    await factoryPage.goto("/app/proofs");
    await expect(factoryPage.getByRole("heading", { name: "Queue feasibility proof" })).toBeVisible({ timeout: 20_000 });
    await factoryPage.getByLabel("Authorized order version").selectOption(anchoredOrder.orderVersionId);
    await factoryPage.getByLabel("Active capacity state").selectOption(certified.openingId);
    await factoryPage.getByRole("button", { name: "Queue proof" }).click();

    let proofContext: {
      jobId: string;
      proof: Record<string, unknown>;
      publicSignals: string[];
      proofTxHash: Hex;
      proofBlock: number;
      allocationId: string;
      chainAllocationId: string | null;
    } | null = null;
    await expect.poll(async () => {
      const { data: job, error: jobError } = await service
        .from("proof_jobs")
        .select("id,status,proof,public_inputs,chain_tx_hash,chain_block_number,error_code,error_detail")
        .eq("order_version_id", anchoredOrder.orderVersionId)
        .eq("capacity_opening_id", certified.openingId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) return "proof-job-pending";
      if (job.status === "failed" || job.status === "stale") {
        throw new Error(`PoFC ${job.status}: ${job.error_code ?? "unknown"} ${job.error_detail ?? ""}`);
      }
      const stored = job.public_inputs as { signals?: unknown } | null;
      const signals = Array.isArray(stored?.signals) && stored.signals.every((value) => typeof value === "string")
        ? stored.signals as string[]
        : null;
      if (job.status !== "confirmed" || !job.proof || !signals || signals.length !== 9 || !job.chain_tx_hash || !job.chain_block_number) {
        return `proof-${job.status}`;
      }
      const { data: allocation, error: allocationError } = await service
        .from("capacity_allocations")
        .select("id,chain_allocation_id,chain_tx_hash,chain_block_number,old_commitment,new_commitment,order_commitment,nullifier")
        .eq("order_version_id", anchoredOrder.orderVersionId)
        .eq("chain_tx_hash", job.chain_tx_hash)
        .maybeSingle();
      if (allocationError) throw allocationError;
      if (!allocation || !allocation.chain_block_number) return "allocation-pending";
      if (BigInt(allocation.old_commitment) !== BigInt(signals[5]!) || BigInt(allocation.new_commitment) !== BigInt(signals[6]!) || BigInt(allocation.nullifier) !== BigInt(signals[8]!)) {
        return "allocation-signal-mismatch";
      }
      proofContext = {
        jobId: job.id,
        proof: job.proof as Record<string, unknown>,
        publicSignals: signals,
        proofTxHash: job.chain_tx_hash as Hex,
        proofBlock: job.chain_block_number,
        allocationId: allocation.id,
        chainAllocationId: allocation.chain_allocation_id,
      };
      return "confirmed";
    }, { timeout: 150_000, intervals: [1_000, 1_500, 2_000, 3_000, 5_000] }).toBe("confirmed");
    expect(proofContext).not.toBeNull();
    const proved = proofContext!;

    await factoryPage.reload({ waitUntil: "domcontentloaded" });
    await expect(factoryPage.getByText("confirmed", { exact: true }).first()).toBeVisible();
    await expect(factoryPage.getByText(externalReference, { exact: false }).first()).toBeVisible();

    const [state, usedNullifier, verifierProvenance] = await Promise.all([
      publicClient.readContract({
        address: capacityVaultAddress!,
        abi: capacityVaultAbi,
        functionName: "getCapacityState",
        args: [FACTORY_CHAIN_ID, certified.chainPeriodId, certified.chainProcessId],
      }),
      publicClient.readContract({
        address: capacityVaultAddress!,
        abi: capacityVaultAbi,
        functionName: "usedNullifiers",
        args: [BigInt(proved.publicSignals[8]!)],
      }),
      publicClient.readContract({
        address: capacityVaultAddress!,
        abi: capacityVaultAbi,
        functionName: "getVerifierProvenance",
        args: [1],
      }),
    ]);
    expect(state.active).toBe(true);
    expect(state.activeCommitment).toBe(BigInt(proved.publicSignals[6]!));
    expect(state.capacityCredentialId.toLowerCase()).toBe(certified.chainCredentialId.toLowerCase());
    expect(state.policyHash.toLowerCase()).toBe(POLICY_HASH.toLowerCase());
    expect(usedNullifier).toBe(true);
    expect(verifierProvenance.verifier).not.toBe("0x0000000000000000000000000000000000000000");
    expect(verifierProvenance.circuitArtifactHash).not.toBe(`0x${"00".repeat(32)}`);
    expect(verifierProvenance.verificationKeyHash).not.toBe(`0x${"00".repeat(32)}`);
    expect(verifierProvenance.verifierCodeHash).not.toBe(`0x${"00".repeat(32)}`);

    // Re-submit the exact already-consumed proof as a real transaction from the mapped factory.
    // The transaction is forced past client-side estimation so the canonical contract rejection
    // itself is recorded on chain. State-predecessor consumption should fail before nullifier reuse.
    const calldataProof = proofCalldata(proved.proof);
    const spendRequest = {
      factoryOrganizationId: FACTORY_CHAIN_ID,
      periodId: certified.chainPeriodId,
      processId: certified.chainProcessId,
      orderId: anchoredOrder.chainOrderId,
      policyHash: POLICY_HASH,
      oldCapacityCommitment: BigInt(proved.publicSignals[5]!),
      newCapacityCommitment: BigInt(proved.publicSignals[6]!),
      orderCommitment: BigInt(proved.publicSignals[7]!),
      nullifier: BigInt(proved.publicSignals[8]!),
      circuitVersion: 1,
    } as const;

    let replaySimulationError = "";
    try {
      await publicClient.simulateContract({
        address: capacityVaultAddress!,
        abi: capacityVaultAbi,
        functionName: "spendCapacity",
        args: [spendRequest, calldataProof.a, calldataProof.b, calldataProof.c],
        account: factoryAddress as Address,
      });
    } catch (caught) {
      replaySimulationError = caught instanceof Error ? caught.message : String(caught);
    }
    expect(replaySimulationError).toContain("StaleCapacityState");

    const factoryAccount = privateKeyToAccount(factoryPrivateKey!);
    expect(factoryAccount.address.toLowerCase()).toBe(factoryAddress.toLowerCase());
    const factoryWallet = createWalletClient({ account: factoryAccount, transport: http(rpcUrl!, { timeout: 8_000 }) });
    const replayData = encodeFunctionData({
      abi: capacityVaultAbi,
      functionName: "spendCapacity",
      args: [spendRequest, calldataProof.a, calldataProof.b, calldataProof.c],
    });
    const replayTxHash = await factoryWallet.sendTransaction({
      to: capacityVaultAddress!,
      data: replayData,
      gas: 1_500_000n,
    });
    const replayReceipt = await publicClient.waitForTransactionReceipt({ hash: replayTxHash, confirmations: 1, timeout: 30_000 });
    expect(replayReceipt.status).toBe("reverted");

    const artifactDirectory = join(process.env.GITHUB_WORKSPACE ?? process.cwd(), "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "browser-chain-pofc-evidence.json"), `${JSON.stringify({
      schemaVersion: 1,
      evidenceClass: "disposable-browser-integration",
      productionEvidence: false,
      trustedSetup: "development-only-groth16",
      sourceSha,
      chainId,
      participants: {
        buyerSigner: buyerAddress,
        auditorSigner: auditorAddress,
        factorySigner: factoryAddress,
        factoryOrganizationId: FACTORY_CHAIN_ID,
      },
      order: {
        purchaseOrderId,
        externalReference,
        chainOrderId: anchoredOrder.chainOrderId,
        orderVersionId: anchoredOrder.orderVersionId,
        authorizationTxHash: anchoredOrder.orderTxHash,
        authorizationBlock: anchoredOrder.orderBlock,
        orderCommitment: anchoredOrder.orderCommitment,
      },
      certification: {
        jobId: certified.jobId,
        openingId: certified.openingId,
        chainCredentialId: certified.chainCredentialId,
        credentialTxHash: certified.credentialTxHash,
        credentialBlock: certified.credentialBlock,
        certificationTxHash: certified.certificationTxHash,
        certificationBlock: certified.certificationBlock,
        periodId: certified.chainPeriodId,
        processId: certified.chainProcessId,
        initialCommitment: certified.oldCommitment,
      },
      pofc: {
        proofJobId: proved.jobId,
        proofTxHash: proved.proofTxHash,
        proofBlock: proved.proofBlock,
        allocationId: proved.allocationId,
        chainAllocationId: proved.chainAllocationId,
        oldCommitment: proved.publicSignals[5],
        newCommitment: proved.publicSignals[6],
        orderCommitment: proved.publicSignals[7],
        nullifier: proved.publicSignals[8],
        canonicalSuccessorMatches: state.activeCommitment === BigInt(proved.publicSignals[6]!),
        nullifierConsumed: usedNullifier,
      },
      verifierProvenance: {
        verifier: verifierProvenance.verifier,
        circuitArtifactHash: verifierProvenance.circuitArtifactHash,
        verificationKeyHash: verifierProvenance.verificationKeyHash,
        verifierCodeHash: verifierProvenance.verifierCodeHash,
      },
      staleReplay: {
        rejected: replayReceipt.status === "reverted",
        expectedError: "StaleCapacityState",
        simulationErrorObserved: replaySimulationError.includes("StaleCapacityState"),
        transactionHash: replayTxHash,
        blockNumber: Number(replayReceipt.blockNumber),
      },
      applicationReconciled: true,
      browserConfirmed: true,
    }, null, 2)}\n`);

    await factoryContext.close();
  });
});
