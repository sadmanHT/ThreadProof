import { randomUUID } from "node:crypto";
import { createPublicClient, http, type Hex } from "viem";
import { type Groth16Proof } from "snarkjs";
import { capacityVaultAbi } from "./chain.js";
import { getProofSubmitterEnv } from "./env.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

function requireHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new Error(`${label} must be canonical bytes32 hex`);
  return value as Hex;
}

function errorDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
}

function proofCalldata(proof: Groth16Proof) {
  if (!proof.pi_a?.[0] || !proof.pi_a?.[1] || !proof.pi_b?.[0]?.[0] || !proof.pi_b?.[1]?.[0] || !proof.pi_c?.[0] || !proof.pi_c?.[1]) {
    throw new Error("Stored Groth16 proof is malformed");
  }
  const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint];
  const b = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ] as [[bigint, bigint], [bigint, bigint]];
  const c = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint];
  return { a, b, c };
}

async function releaseStaleClaims(supabase: ServiceClient) {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from("proof_jobs")
    .update({ worker_claim_token: null, worker_claimed_at: null })
    .eq("status", "generated")
    .lt("worker_claimed_at", cutoff);
}

async function claimGeneratedJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase
    .from("proof_jobs")
    .select("*")
    .eq("status", "generated")
    .is("worker_claim_token", null)
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data, error: claimError } = await supabase
      .from("proof_jobs")
      .update({ worker_claim_token: token, worker_claimed_at: claimedAt, error_code: null, error_detail: null })
      .eq("id", candidate.id)
      .eq("status", "generated")
      .is("worker_claim_token", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function releaseForSignerRetry(supabase: ServiceClient, job: Row, error: RelayerSignerUnavailableError) {
  await supabase
    .from("proof_jobs")
    .update({
      status: "generated",
      worker_claim_token: null,
      worker_claimed_at: null,
      error_code: "SIGNER_UNAVAILABLE",
      error_detail: error.message,
    })
    .eq("id", job.id)
    .eq("status", "generated")
    .eq("worker_claim_token", job.worker_claim_token);
}

async function finalizeConfirmedSpend(
  supabase: ServiceClient,
  job: Row,
  txHash: Hex,
  blockNumber: bigint,
  publicSignals: string[],
) {
  const { data: privateState, error: privateStateError } = await supabase
    .from("proof_job_private_state")
    .select("*")
    .eq("proof_job_id", job.id)
    .single();
  if (privateStateError) throw privateStateError;

  const [oldCommitment, newCommitment, orderCommitment, nullifier] = publicSignals.slice(5).map(BigInt);
  if (oldCommitment == null || newCommitment == null || orderCommitment == null || nullifier == null) {
    throw new Error("Confirmed proof is missing capacity public signals");
  }

  const block = Number(blockNumber);
  if (!Number.isSafeInteger(block)) throw new Error("Block number exceeds JavaScript safe integer range");
  const confirmedAt = new Date().toISOString();

  const { data: updatedOpening, error: openingError } = await supabase
    .from("private_capacity_openings")
    .update({
      capacity_commitment: newCommitment.toString(),
      encrypted_remaining_capacity: privateState.next_capacity_ciphertext,
      encrypted_randomness: privateState.next_randomness_ciphertext,
      last_chain_block: block,
      status: "active",
      updated_at: confirmedAt,
    })
    .eq("id", job.capacity_opening_id)
    .eq("capacity_commitment", oldCommitment.toString())
    .select("id")
    .maybeSingle();
  if (openingError) throw openingError;
  if (!updatedOpening) throw new Error("Private capacity mirror no longer opens the confirmed old commitment");

  const { error: allocationError } = await supabase.from("capacity_allocations").upsert({
    capacity_opening_id: job.capacity_opening_id,
    order_version_id: job.order_version_id,
    old_commitment: oldCommitment.toString(),
    new_commitment: newCommitment.toString(),
    order_commitment: orderCommitment.toString(),
    nullifier: nullifier.toString(),
    chain_tx_hash: txHash,
    chain_block_number: block,
    confirmed_at: confirmedAt,
  }, { onConflict: "chain_tx_hash", ignoreDuplicates: true });
  if (allocationError) throw allocationError;

  const { error: jobError } = await supabase
    .from("proof_jobs")
    .update({
      status: "confirmed",
      chain_tx_hash: txHash,
      chain_block_number: block,
      completed_at: confirmedAt,
      error_code: null,
      error_detail: null,
      worker_claim_token: null,
      worker_claimed_at: null,
    })
    .eq("id", job.id);
  if (jobError) throw jobError;

  await supabase.from("proof_job_private_state").delete().eq("proof_job_id", job.id);
}

async function submit(supabase: ServiceClient, job: Row) {
  const env = getProofSubmitterEnv();
  const stored = job.public_inputs as { signals?: unknown; request?: Record<string, unknown> } | null;
  const publicSignals = Array.isArray(stored?.signals) && stored.signals.every((value) => typeof value === "string")
    ? stored.signals as string[]
    : null;
  if (!publicSignals || publicSignals.length !== 9) throw new Error("Stored proof job does not contain nine public signals");

  const request = stored?.request ?? {};
  const factoryOrganizationId = requireHex32(request.factoryOrganizationId, "factory organization id");
  const periodId = requireHex32(request.periodId, "period id");
  const processId = requireHex32(request.processId, "process id");
  const orderId = requireHex32(request.orderId, "order id");
  const policyHash = requireHex32(request.policyHash, "policy hash");
  const proof = job.proof as Groth16Proof;
  const { a, b, c } = proofCalldata(proof);

  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) {
    throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);
  }

  const spendRequest = {
    factoryOrganizationId,
    periodId,
    processId,
    orderId,
    policyHash,
    oldCapacityCommitment: BigInt(publicSignals[5]!),
    newCapacityCommitment: BigInt(publicSignals[6]!),
    orderCommitment: BigInt(publicSignals[7]!),
    nullifier: BigInt(publicSignals[8]!),
    circuitVersion: Number(job.circuit_version),
  } as const;

  let txHash: Hex | null = null;
  try {
    const { account, wallet } = await createRelayerWallet(env, chainId);
    const { request: simulated } = await publicClient.simulateContract({
      address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Hex,
      abi: capacityVaultAbi,
      functionName: "spendCapacity",
      args: [spendRequest, a, b, c],
      account,
    });
    txHash = await wallet.writeContract(simulated);

    const { error: submittedError } = await supabase
      .from("proof_jobs")
      .update({
        status: "submitted",
        chain_tx_hash: txHash,
        worker_claim_token: null,
        worker_claimed_at: null,
        error_code: null,
        error_detail: null,
      })
      .eq("id", job.id)
      .eq("status", "generated")
      .eq("worker_claim_token", job.worker_claim_token);
    if (submittedError) throw submittedError;

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`Capacity spend transaction reverted: ${txHash}`);
    await finalizeConfirmedSpend(supabase, job, txHash, receipt.blockNumber, publicSignals);
    console.log(`Confirmed PoFC spend for job ${job.id} in block ${receipt.blockNumber}`);
  } catch (error) {
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, job, error);
      return;
    }

    if (txHash) {
      // Once a transaction hash exists, leave the job submitted so the canonical event indexer can settle it.
      await supabase.from("proof_jobs").update({
        status: "submitted",
        chain_tx_hash: txHash,
        error_code: "CHAIN_CONFIRMATION_PENDING",
        error_detail: errorDetail(error),
        worker_claim_token: null,
        worker_claimed_at: null,
      }).eq("id", job.id);
      return;
    }

    const message = errorDetail(error);
    const stale = /StaleCapacityState|NullifierAlreadyUsed|InvalidOrderAuthorization/.test(message);
    await supabase.from("proof_jobs").update({
      status: stale ? "stale" : "failed",
      error_code: stale ? "CHAIN_STATE_STALE" : "CHAIN_SUBMISSION_FAILED",
      error_detail: message,
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
    }).eq("id", job.id).eq("status", "generated");
  }
}

async function main() {
  const env = getProofSubmitterEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`ThreadProof proof submitter started with ${env.THREADPROOF_SIGNER_MODE} signing`);

  while (true) {
    await releaseStaleClaims(supabase);
    const job = await claimGeneratedJob(supabase);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    await submit(supabase, job);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
