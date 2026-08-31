import { randomUUID } from "node:crypto";
import { createPublicClient, http, type Hex } from "viem";
import { type Groth16Proof } from "snarkjs";
import { capacityVaultAbi } from "./chain.js";
import { getProofSubmitterEnv } from "./env.js";
import {
  type ClaimLease,
  WorkerClaimLostError,
  staleClaimCutoffIso,
  startClaimLease,
} from "./job-lease.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

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

async function releaseStaleClaims(supabase: ServiceClient, leaseSeconds: number) {
  const cutoff = staleClaimCutoffIso(leaseSeconds);
  const { error } = await supabase
    .from("proof_jobs")
    .update({ worker_claim_token: null, worker_claimed_at: null })
    .eq("status", "generated")
    .lt("worker_claimed_at", cutoff);
  if (error) throw error;
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

async function renewGeneratedClaim(supabase: ServiceClient, job: Row) {
  const { data, error } = await supabase
    .from("proof_jobs")
    .update({ worker_claimed_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "generated")
    .eq("worker_claim_token", job.worker_claim_token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

async function releaseForSignerRetry(supabase: ServiceClient, job: Row, error: RelayerSignerUnavailableError) {
  const { error: releaseError } = await supabase
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
  if (releaseError) throw releaseError;
}

async function persistBroadcast(supabase: ServiceClient, job: Row, txHash: Hex) {
  const { data, error } = await supabase
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
    .eq("worker_claim_token", job.worker_claim_token)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new BroadcastPersistenceError(txHash, `CapacityVault broadcast ${txHash} could not be persisted: ${error.message}`);
  }
  if (!data) {
    throw new WorkerClaimLostError(`Proof job ${job.id} claim was lost after broadcasting ${txHash}.`);
  }
}

async function observeBroadcastReceipt(
  supabase: ServiceClient,
  job: Row,
  txHash: Hex,
  publicClient: ReturnType<typeof createPublicClient>,
) {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") {
      const { error } = await supabase.from("proof_jobs").update({
        status: "failed",
        chain_block_number: Number(receipt.blockNumber),
        completed_at: new Date().toISOString(),
        error_code: "CHAIN_TRANSACTION_REVERTED",
        error_detail: `CapacityVault transaction reverted: ${txHash}`,
      }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
      if (error) throw error;
      return;
    }

    const { error } = await supabase.from("proof_jobs").update({
      chain_block_number: Number(receipt.blockNumber),
      error_code: null,
      error_detail: null,
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
    if (error) throw error;

    // Do not materialize the next private opening here. The canonical CapacitySpent
    // event trigger reconciles the generated encrypted next state and marks confirmation.
    console.log(`Observed successful PoFC spend ${txHash}; waiting for canonical event indexing for job ${job.id}`);
  } catch (error) {
    const { error: updateError } = await supabase.from("proof_jobs").update({
      error_code: "CHAIN_CONFIRMATION_PENDING",
      error_detail: errorDetail(error),
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
  await lease.renewNow();

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

  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request: simulated } = await publicClient.simulateContract({
    address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Hex,
    abi: capacityVaultAbi,
    functionName: "spendCapacity",
    args: [spendRequest, a, b, c],
    account,
  });
  await lease.renewNow();

  const txHash = await wallet.writeContract(simulated);

  // The transaction hash is the crash-recovery boundary. Stop lease renewal and persist
  // it immediately. If ownership or database access is lost here, the canonical
  // CapacitySpent trigger can still recover this generated job by its nullifier.
  lease.stop();
  await persistBroadcast(supabase, job, txHash);
  await observeBroadcastReceipt(supabase, job, txHash, publicClient);
}

async function processGeneratedJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const lease = startClaimLease({
    heartbeatSeconds,
    label: `proof submission job ${job.id}`,
    renew: () => renewGeneratedClaim(supabase, job),
  });

  try {
    await lease.renewNow();
    await submit(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) {
      console.warn(`Stopped proof submission ${job.id} after claim loss: ${error.message}`);
      return;
    }
    if (error instanceof BroadcastPersistenceError) {
      console.error(`Proof submission ${job.id} broadcast ${error.txHash} but persistence failed; canonical CapacitySpent recovery remains available: ${error.message}`);
      return;
    }
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, job, error);
      return;
    }

    const message = errorDetail(error);
    const stale = /StaleCapacityState|NullifierAlreadyUsed|InvalidOrderAuthorization/.test(message);
    const { error: updateError } = await supabase.from("proof_jobs").update({
      status: stale ? "stale" : "failed",
      error_code: stale ? "CHAIN_STATE_STALE" : "CHAIN_SUBMISSION_FAILED",
      error_detail: message,
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
    })
      .eq("id", job.id)
      .eq("status", "generated")
      .eq("worker_claim_token", job.worker_claim_token);
    if (updateError) throw updateError;
  } finally {
    lease.stop();
  }
}

async function main() {
  const env = getProofSubmitterEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`ThreadProof proof submitter started with ${env.THREADPROOF_SIGNER_MODE} signing`);

  while (true) {
    await releaseStaleClaims(supabase, env.THREADPROOF_WORKER_LEASE_SECONDS);
    const job = await claimGeneratedJob(supabase);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    await processGeneratedJob(supabase, job, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
