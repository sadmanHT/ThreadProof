import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";
import { bufferToBytea, byteaToBuffer, decodeDataKey, decryptDetached, decryptEmbedded, encryptEmbedded } from "./crypto.js";
import { getProofEnv, parseFactorySecrets } from "./env.js";
import { type ClaimLease, WorkerClaimLostError, staleClaimCutoffIso, startClaimLease } from "./job-lease.js";
import { createServiceClient } from "./supabase.js";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const UINT64_MAX = (1n << 64n) - 1n;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const orderPayloadSchema = z.object({
  orderWorkload: z.string().regex(/^[0-9]+$/),
  orderRandomness: z.string().regex(/^[0-9]+$/),
});

const releaseReadAbi = parseAbi([
  "function getCapacityState(bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId) view returns ((uint256 activeCommitment,bytes32 capacityCredentialId,bytes32 policyHash,uint32 circuitVersion,uint64 updatedAt,bool active))",
  "function getCapacityAllocation(bytes32 allocationId) view returns ((bytes32 stateKey,bytes32 orderId,bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,bytes32 capacityCredentialId,uint256 orderCommitment,bytes32 policyHash,uint256 nullifier,uint32 circuitVersion,uint64 authorizedAt,bool exists))",
  "function isCapacityAllocationAuthorized(bytes32 allocationId,bytes32 orderId,bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,uint256 orderCommitment,bytes32 policyHash) view returns (bool)",
  "function releasedAllocations(bytes32 allocationId) view returns (bool)",
]);

type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

class ReleaseEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseEligibilityError";
  }
}

function requireHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new Error(`${label} must be canonical bytes32 hex`);
  return value as Hex;
}

function sameHex(left: unknown, right: unknown) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function fieldFromBytes32(value: Hex) {
  return BigInt(value) % SNARK_FIELD;
}

function scalarFromEncrypted(value: string, key: Buffer, label: string) {
  const plaintext = decryptEmbedded(byteaToBuffer(value), key).trim();
  if (!/^[0-9]+$/.test(plaintext)) throw new Error(`${label} decrypted to a non-decimal scalar`);
  return BigInt(plaintext);
}

function randomFieldElement() {
  return BigInt(`0x${randomBytes(30).toString("hex")}`);
}

async function releaseStaleClaims(supabase: ServiceClient, leaseSeconds: number) {
  const { error } = await supabase.from("capacity_release_jobs").update({
    status: "queued",
    worker_claim_token: null,
    worker_claimed_at: null,
    updated_at: new Date().toISOString(),
  }).eq("status", "generating").lt("worker_claimed_at", staleClaimCutoffIso(leaseSeconds));
  if (error) throw error;
}

async function claimQueuedJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase.from("capacity_release_jobs")
    .select("*").eq("status", "queued").is("worker_claim_token", null)
    .order("created_at", { ascending: true }).limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data, error: claimError } = await supabase.from("capacity_release_jobs").update({
      status: "generating",
      started_at: claimedAt,
      worker_claim_token: token,
      worker_claimed_at: claimedAt,
      error_code: null,
      error_detail: null,
      updated_at: claimedAt,
    }).eq("id", candidate.id).eq("status", "queued").is("worker_claim_token", null).select("*").maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function renewClaim(supabase: ServiceClient, job: Row) {
  const { data, error } = await supabase.from("capacity_release_jobs").update({
    worker_claimed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", job.id).eq("status", "generating").eq("worker_claim_token", job.worker_claim_token).select("id").maybeSingle();
  if (error) throw error;
  return data != null;
}

async function generateRelease(supabase: ServiceClient, job: Row, lease: ClaimLease) {
  const env = getProofEnv();
  if (env.THREADPROOF_SIGNER_MODE !== "disabled") {
    throw new Error("The capacity release prover must run with transaction signing disabled.");
  }

  const key = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);
  const factorySecrets = parseFactorySecrets(env.THREADPROOF_FACTORY_SECRETS_JSON);

  const { data: allocation, error: allocationError } = await supabase.from("capacity_allocations").select("*").eq("id", job.capacity_allocation_id).single();
  if (allocationError) throw allocationError;
  if (!allocation.chain_allocation_id || !sameHex(allocation.chain_allocation_id, job.chain_allocation_id)) {
    throw new ReleaseEligibilityError("Release job is not bound to the canonical allocation identifier.");
  }
  if (allocation.released_at || allocation.release_tx_hash) throw new ReleaseEligibilityError("Capacity allocation is already released.");

  const { data: opening, error: openingError } = await supabase.from("private_capacity_openings").select("*").eq("id", job.capacity_opening_id).single();
  if (openingError) throw openingError;
  if (opening.id !== allocation.capacity_opening_id) throw new ReleaseEligibilityError("Release job and allocation refer to different capacity openings.");
  if (opening.status !== "active") throw new ReleaseEligibilityError("Private capacity opening is not active.");

  const { data: version, error: versionError } = await supabase.from("order_versions").select("*").eq("id", job.order_version_id).single();
  if (versionError) throw versionError;
  if (version.id !== allocation.order_version_id || BigInt(version.order_commitment) !== BigInt(allocation.order_commitment)) {
    throw new ReleaseEligibilityError("Release job is not bound to the historical allocation order commitment.");
  }

  const { data: order, error: orderError } = await supabase.from("purchase_orders").select("*").eq("id", version.purchase_order_id).single();
  if (orderError) throw orderError;
  const { data: factory, error: factoryError } = await supabase.from("organizations").select("*").eq("id", opening.factory_organization_id).single();
  if (factoryError) throw factoryError;

  const factoryId = requireHex32(factory.chain_organization_id, "factory organization id");
  const periodId = requireHex32(opening.chain_period_id, "period id");
  const processId = requireHex32(opening.chain_process_id, "process id");
  const orderId = requireHex32(order.chain_order_id, "order id");
  const policyHash = requireHex32(opening.policy_hash, "policy hash");
  const stateKey = requireHex32(opening.chain_state_key, "capacity state key");
  const chainAllocationId = requireHex32(job.chain_allocation_id, "allocation id");

  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && chainId !== env.THREADPROOF_CHAIN_ID) throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);

  const [chainState, chainAllocation, alreadyReleased] = await Promise.all([
    publicClient.readContract({ address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address, abi: releaseReadAbi, functionName: "getCapacityState", args: [factoryId, periodId, processId] }),
    publicClient.readContract({ address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address, abi: releaseReadAbi, functionName: "getCapacityAllocation", args: [chainAllocationId] }),
    publicClient.readContract({ address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address, abi: releaseReadAbi, functionName: "releasedAllocations", args: [chainAllocationId] }),
  ]);
  await lease.renewNow();

  if (alreadyReleased) throw new ReleaseEligibilityError("Canonical allocation is already released.");
  if (!chainState.active || BigInt(chainState.activeCommitment) !== BigInt(opening.capacity_commitment) || !sameHex(chainState.policyHash, policyHash)) {
    throw new ReleaseEligibilityError("Private opening is stale against canonical capacity state.");
  }
  if (!chainAllocation.exists || !sameHex(chainAllocation.stateKey, stateKey) || !sameHex(chainAllocation.orderId, orderId) || !sameHex(chainAllocation.factoryOrganizationId, factoryId) || !sameHex(chainAllocation.policyHash, policyHash) || BigInt(chainAllocation.orderCommitment) !== BigInt(allocation.order_commitment)) {
    throw new ReleaseEligibilityError("Canonical allocation receipt does not match the staged release job.");
  }

  const stillAuthorized = await publicClient.readContract({
    address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address,
    abi: releaseReadAbi,
    functionName: "isCapacityAllocationAuthorized",
    args: [chainAllocationId, orderId, factoryId, periodId, processId, BigInt(allocation.order_commitment), policyHash],
  });
  if (stillAuthorized) throw new ReleaseEligibilityError("Historical allocation is still current and cannot be released.");
  await lease.renewNow();

  const currentCapacity = scalarFromEncrypted(opening.encrypted_remaining_capacity, key, "current capacity");
  const currentRandomness = scalarFromEncrypted(opening.encrypted_randomness, key, "current capacity randomness");
  if (currentCapacity > UINT64_MAX) throw new Error("Current capacity exceeds uint64 range.");

  const orderPayloadText = decryptDetached(byteaToBuffer(version.confidential_payload_ciphertext), byteaToBuffer(version.payload_nonce), key);
  const orderPayload = orderPayloadSchema.parse(JSON.parse(orderPayloadText));
  const orderWorkload = BigInt(orderPayload.orderWorkload);
  const orderRandomness = BigInt(orderPayload.orderRandomness);
  if (orderWorkload > UINT64_MAX || currentCapacity + orderWorkload > UINT64_MAX) {
    throw new ReleaseEligibilityError("Restored capacity would exceed the circuit uint64 range.");
  }

  const releaseSecret = factorySecrets.get(factoryId.toLowerCase());
  if (releaseSecret == null || releaseSecret <= 0n || releaseSecret >= SNARK_FIELD) throw new Error(`No valid release nullifier secret configured for factory ${factoryId}`);

  const poseidon = await buildPoseidon();
  const hash = (values: bigint[]) => BigInt(poseidon.F.toString(poseidon(values)));
  const factoryField = fieldFromBytes32(factoryId);
  const periodField = fieldFromBytes32(periodId);
  const processField = fieldFromBytes32(processId);
  const orderField = fieldFromBytes32(orderId);
  const policyField = fieldFromBytes32(policyHash);

  const currentCommitment = hash([factoryField, periodField, processField, policyField, currentCapacity, currentRandomness, 1n]);
  if (currentCommitment !== BigInt(opening.capacity_commitment)) throw new ReleaseEligibilityError("Encrypted current opening does not open the canonical capacity commitment.");
  const orderCommitment = hash([orderField, orderWorkload, orderRandomness, 2n]);
  if (orderCommitment !== BigInt(allocation.order_commitment)) throw new ReleaseEligibilityError("Encrypted historical order payload does not open the immutable allocation commitment.");

  const restoredCapacity = currentCapacity + orderWorkload;
  const restoredRandomness = randomFieldElement();
  const restoredCommitment = hash([factoryField, periodField, processField, policyField, restoredCapacity, restoredRandomness, 1n]);
  const releaseNullifier = hash([currentCommitment, orderCommitment, releaseSecret, 4n]);

  const circuitInput = {
    factoryId: factoryField.toString(), periodId: periodField.toString(), processId: processField.toString(),
    orderId: orderField.toString(), policyHash: policyField.toString(),
    oldCapacityCommitment: currentCommitment.toString(), newCapacityCommitment: restoredCommitment.toString(),
    orderCommitment: orderCommitment.toString(), nullifier: releaseNullifier.toString(),
    currentCapacity: currentCapacity.toString(), restoredCapacity: restoredCapacity.toString(), orderWorkload: orderWorkload.toString(),
    currentRandomness: currentRandomness.toString(), restoredRandomness: restoredRandomness.toString(), orderRandomness: orderRandomness.toString(),
    releaseNullifierSecret: releaseSecret.toString(),
  };

  await lease.renewNow();
  const { proof, publicSignals } = await groth16.fullProve(circuitInput, env.THREADPROOF_CAPACITY_WASM_PATH, env.THREADPROOF_CAPACITY_ZKEY_PATH);
  await lease.renewNow();
  const expectedSignals = [factoryField, periodField, processField, orderField, policyField, currentCommitment, restoredCommitment, orderCommitment, releaseNullifier].map(String);
  if (publicSignals.length !== 9 || publicSignals.some((value, index) => value !== expectedSignals[index])) throw new Error("Release prover returned unexpected public signals.");

  if (env.THREADPROOF_CAPACITY_VKEY_PATH) {
    const vkey = JSON.parse(await readFile(env.THREADPROOF_CAPACITY_VKEY_PATH, "utf8"));
    if (!(await groth16.verify(vkey, publicSignals, proof))) throw new Error("Generated capacity release proof failed local verification.");
  }
  await lease.renewNow();

  const now = new Date().toISOString();
  const { data: finalized, error: finalizeError } = await supabase.from("capacity_release_jobs").update({
    status: "generated",
    proof,
    public_inputs: {
      signals: publicSignals,
      request: { allocationId: chainAllocationId, stateKey, orderId, releaseCircuitVersion: job.release_circuit_version },
    },
    next_capacity_ciphertext: bufferToBytea(encryptEmbedded(restoredCapacity.toString(), key)),
    next_randomness_ciphertext: bufferToBytea(encryptEmbedded(restoredRandomness.toString(), key)),
    worker_claim_token: null,
    worker_claimed_at: null,
    error_code: null,
    error_detail: null,
    updated_at: now,
  }).eq("id", job.id).eq("status", "generating").eq("worker_claim_token", job.worker_claim_token).select("id").maybeSingle();
  if (finalizeError) throw finalizeError;
  if (!finalized) throw new WorkerClaimLostError(`Capacity release job ${job.id} claim was lost before finalization.`);
  console.log(`Generated CapacityRelease proof for allocation ${chainAllocationId}`);
}

async function processJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const lease = startClaimLease({ heartbeatSeconds, label: `capacity release proof job ${job.id}`, renew: () => renewClaim(supabase, job) });
  try {
    await lease.renewNow();
    await generateRelease(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) return;
    const message = error instanceof Error ? error.message : String(error);
    const stale = error instanceof ReleaseEligibilityError;
    await supabase.from("capacity_release_jobs").update({
      status: stale ? "stale" : "failed",
      error_code: stale ? "RELEASE_NOT_ELIGIBLE" : "RELEASE_PROOF_GENERATION_FAILED",
      error_detail: message.slice(0, 4000),
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "generating").eq("worker_claim_token", job.worker_claim_token);
  } finally {
    lease.stop();
  }
}

async function main() {
  const env = getProofEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log("ThreadProof capacity release proof generator started");
  while (true) {
    await releaseStaleClaims(supabase, env.THREADPROOF_WORKER_LEASE_SECONDS);
    const job = await claimQueuedJob(supabase);
    if (!job) { await new Promise((resolve) => setTimeout(resolve, 2_000)); continue; }
    await processJob(supabase, job, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
