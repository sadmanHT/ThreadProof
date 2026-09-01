import { randomUUID } from "node:crypto";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import type { Groth16Proof } from "snarkjs";
import { getProofSubmitterEnv } from "./env.js";
import { type ClaimLease, WorkerClaimLostError, staleClaimCutoffIso, startClaimLease } from "./job-lease.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

const releaseAbi = parseAbi([
  "function releaseCapacity((bytes32 allocationId,uint256 oldCapacityCommitment,uint256 newCapacityCommitment,uint256 releaseNullifier,uint32 releaseCircuitVersion) request,uint256[2] a,uint256[2][2] b,uint256[2] c)",
]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

class BroadcastPersistenceError extends Error {
  constructor(readonly txHash: Hex, message: string) {
    super(message);
    this.name = "BroadcastPersistenceError";
  }
}

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
    throw new Error("Stored CapacityRelease Groth16 proof is malformed");
  }
  const a = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint];
  const b = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ] as [[bigint, bigint], [bigint, bigint]];
  const c = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint];
  return { a, b, c };
}

async function releaseStaleClaims(supabase: ServiceClient, leaseSeconds: number) {
  const { error } = await supabase.from("capacity_release_jobs").update({
    worker_claim_token: null,
    worker_claimed_at: null,
    updated_at: new Date().toISOString(),
  }).eq("status", "generated").lt("worker_claimed_at", staleClaimCutoffIso(leaseSeconds));
  if (error) throw error;
}

async function claimGeneratedJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase.from("capacity_release_jobs")
    .select("*").eq("status", "generated").is("worker_claim_token", null)
    .order("created_at", { ascending: true }).limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data, error: claimError } = await supabase.from("capacity_release_jobs").update({
      worker_claim_token: token,
      worker_claimed_at: claimedAt,
      error_code: null,
      error_detail: null,
      updated_at: claimedAt,
    }).eq("id", candidate.id).eq("status", "generated").is("worker_claim_token", null).select("*").maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function renewClaim(supabase: ServiceClient, job: Row) {
  const { data, error } = await supabase.from("capacity_release_jobs").update({
    worker_claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", job.id).eq("status", "generated").eq("worker_claim_token", job.worker_claim_token).select("id").maybeSingle();
  if (error) throw error;
  return data != null;
}

async function releaseForSignerRetry(supabase: ServiceClient, job: Row, error: RelayerSignerUnavailableError) {
  const { error: updateError } = await supabase.from("capacity_release_jobs").update({
    worker_claim_token: null,
    worker_claimed_at: null,
    error_code: "SIGNER_UNAVAILABLE",
    error_detail: error.message,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id).eq("status", "generated").eq("worker_claim_token", job.worker_claim_token);
  if (updateError) throw updateError;
}

async function persistBroadcast(supabase: ServiceClient, job: Row, txHash: Hex) {
  const { data, error } = await supabase.from("capacity_release_jobs").update({
    status: "submitted",
    chain_tx_hash: txHash,
    worker_claim_token: null,
    worker_claimed_at: null,
    error_code: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id).eq("status", "generated").eq("worker_claim_token", job.worker_claim_token).select("id").maybeSingle();
  if (error) throw new BroadcastPersistenceError(txHash, `CapacityRelease broadcast ${txHash} could not be persisted: ${error.message}`);
  if (!data) throw new WorkerClaimLostError(`Capacity release job ${job.id} claim was lost after broadcasting ${txHash}.`);
}

async function observeReceipt(supabase: ServiceClient, job: Row, txHash: Hex, publicClient: ReturnType<typeof createPublicClient>) {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") {
      const { error } = await supabase.from("capacity_release_jobs").update({
        status: "failed",
        chain_block_number: Number(receipt.blockNumber),
        completed_at: new Date().toISOString(),
        error_code: "CHAIN_TRANSACTION_REVERTED",
        error_detail: `CapacityRelease transaction reverted: ${txHash}`,
        updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
      if (error) throw error;
      return;
    }

    const { error } = await supabase.from("capacity_release_jobs").update({
      chain_block_number: Number(receipt.blockNumber),
      error_code: null,
      error_detail: null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
    if (error) throw error;
    console.log(`Observed successful CapacityRelease ${txHash}; waiting for canonical CapacityReleased indexing for job ${job.id}`);
  } catch (error) {
    const { error: updateError } = await supabase.from("capacity_release_jobs").update({
      error_code: "CHAIN_CONFIRMATION_PENDING",
      error_detail: errorDetail(error),
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
    if (updateError) throw updateError;
  }
}

async function submit(supabase: ServiceClient, job: Row, lease: ClaimLease) {
  const env = getProofSubmitterEnv();
  const stored = job.public_inputs as { signals?: unknown; request?: Record<string, unknown> } | null;
  const publicSignals = Array.isArray(stored?.signals) && stored.signals.every((value) => typeof value === "string")
    ? stored.signals as string[]
    : null;
  if (!publicSignals || publicSignals.length !== 9) throw new Error("Stored capacity release job does not contain nine public signals");

  const request = stored?.request ?? {};
  const allocationId = requireHex32(request.allocationId, "allocation id");
  if (allocationId.toLowerCase() !== String(job.chain_allocation_id).toLowerCase()) throw new Error("Stored release request allocation id does not match the job allocation id");
  const proof = job.proof as Groth16Proof;
  const { a, b, c } = proofCalldata(proof);

  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);
  await lease.renewNow();

  const releaseRequest = {
    allocationId,
    oldCapacityCommitment: BigInt(publicSignals[5]!),
    newCapacityCommitment: BigInt(publicSignals[6]!),
    releaseNullifier: BigInt(publicSignals[8]!),
    releaseCircuitVersion: Number(job.release_circuit_version),
  } as const;

  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request: simulated } = await publicClient.simulateContract({
    address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address,
    abi: releaseAbi,
    functionName: "releaseCapacity",
    args: [releaseRequest, a, b, c],
    account,
  });
  await lease.renewNow();

  const txHash = await wallet.writeContract(simulated);
  lease.stop();
  await persistBroadcast(supabase, job, txHash);
  await observeReceipt(supabase, job, txHash, publicClient);
}

async function processGeneratedJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const lease = startClaimLease({ heartbeatSeconds, label: `capacity release submit job ${job.id}`, renew: () => renewClaim(supabase, job) });
  try {
    await lease.renewNow();
    await submit(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) return;
    if (error instanceof BroadcastPersistenceError) {
      console.error(`Capacity release job ${job.id} broadcast ${error.txHash} but persistence failed; canonical event recovery remains available.`);
      return;
    }
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, job, error);
      return;
    }

    const detail = errorDetail(error);
    const stale = /AllocationStillAuthorized|StaleCapacityState|AllocationAlreadyReleased|ReleaseNullifierAlreadyUsed|UnknownCapacityAllocation/.test(detail);
    const { error: updateError } = await supabase.from("capacity_release_jobs").update({
      status: stale ? "stale" : "failed",
      error_code: stale ? "CHAIN_STATE_STALE" : "CHAIN_SUBMISSION_FAILED",
      error_detail: detail,
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "generated").eq("worker_claim_token", job.worker_claim_token);
    if (updateError) throw updateError;
  } finally {
    lease.stop();
  }
}

async function main() {
  const env = getProofSubmitterEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`ThreadProof capacity release submitter started with ${env.THREADPROOF_SIGNER_MODE} signing`);
  while (true) {
    await releaseStaleClaims(supabase, env.THREADPROOF_WORKER_LEASE_SECONDS);
    const job = await claimGeneratedJob(supabase);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
    await processGeneratedJob(supabase, job, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
