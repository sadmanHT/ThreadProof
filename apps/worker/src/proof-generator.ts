import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import type { Address, Hex } from "viem";
import { z } from "zod";
import {
  assertCanonicalCapacityOpening,
  StaleCanonicalCapacityError,
} from "./canonical-capacity.js";
import {
  bufferToBytea,
  byteaToBuffer,
  decodeDataKey,
  decryptDetached,
  decryptEmbedded,
  encryptEmbedded,
} from "./crypto.js";
import { getProofEnv, parseFactorySecrets } from "./env.js";
import {
  type ClaimLease,
  WorkerClaimLostError,
  staleClaimCutoffIso,
  startClaimLease,
} from "./job-lease.js";
import { createServiceClient } from "./supabase.js";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const UINT64_MAX = (1n << 64n) - 1n;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const orderPayloadSchema = z.object({
  orderWorkload: z.string().regex(/^[0-9]+$/),
  orderRandomness: z.string().regex(/^[0-9]+$/),
});

type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

type JobContext = {
  opening: Row;
  credential: Row;
  version: Row;
  order: Row;
  factory: Row;
};

function requireHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) {
    throw new Error(`${label} must be a canonical bytes32 hex value`);
  }
  return value as Hex;
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

function commitmentHex(value: bigint) {
  return `0x${value.toString(16)}`;
}

async function releaseStaleClaims(supabase: ServiceClient, leaseSeconds: number) {
  const cutoff = staleClaimCutoffIso(leaseSeconds);
  const { error } = await supabase
    .from("proof_jobs")
    .update({ status: "queued", worker_claim_token: null, worker_claimed_at: null })
    .eq("status", "generating")
    .lt("worker_claimed_at", cutoff);
  if (error) throw error;
}

async function claimQueuedJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase
    .from("proof_jobs")
    .select("*")
    .eq("status", "queued")
    .is("worker_claim_token", null)
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    const { data, error: claimError } = await supabase
      .from("proof_jobs")
      .update({
        status: "generating",
        started_at: claimedAt,
        worker_claim_token: token,
        worker_claimed_at: claimedAt,
        error_code: null,
        error_detail: null,
      })
      .eq("id", candidate.id)
      .eq("status", "queued")
      .is("worker_claim_token", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function renewProofClaim(supabase: ServiceClient, job: Row) {
  const { data, error } = await supabase
    .from("proof_jobs")
    .update({ worker_claimed_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "generating")
    .eq("worker_claim_token", job.worker_claim_token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

async function loadContext(supabase: ServiceClient, job: Row): Promise<JobContext> {
  const { data: opening, error: openingError } = await supabase
    .from("private_capacity_openings")
    .select("*")
    .eq("id", job.capacity_opening_id)
    .single();
  if (openingError) throw openingError;

  const { data: credential, error: credentialError } = await supabase
    .from("credentials")
    .select("*")
    .eq("id", opening.capacity_credential_id)
    .single();
  if (credentialError) throw credentialError;

  const { data: version, error: versionError } = await supabase
    .from("order_versions")
    .select("*")
    .eq("id", job.order_version_id)
    .single();
  if (versionError) throw versionError;

  const { data: order, error: orderError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", version.purchase_order_id)
    .single();
  if (orderError) throw orderError;

  const { data: factory, error: factoryError } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", opening.factory_organization_id)
    .single();
  if (factoryError) throw factoryError;

  if (order.factory_organization_id !== opening.factory_organization_id) {
    throw new Error("Order and capacity opening refer to different factories");
  }
  if (order.current_version !== version.version || order.current_order_commitment !== version.order_commitment) {
    throw new Error("Proof job no longer targets the current order version");
  }
  if (version.policy_hash !== opening.policy_hash) {
    throw new Error("Order and capacity opening policy hashes differ");
  }

  return { opening, credential, version, order, factory };
}

async function generateProof(supabase: ServiceClient, job: Row, lease: ClaimLease) {
  const env = getProofEnv();
  if (env.THREADPROOF_SIGNER_MODE !== "disabled") {
    throw new Error("The proof generator must run with transaction signing disabled; use the dedicated proof submitter for chain writes.");
  }

  const key = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);
  const secrets = parseFactorySecrets(env.THREADPROOF_FACTORY_SECRETS_JSON);
  const { opening, credential, version, order, factory } = await loadContext(supabase, job);

  const factoryChainId = requireHex32(factory.chain_organization_id, "factory chain organization id");
  const capacityCredentialChainId = requireHex32(credential.chain_credential_id, "capacity credential id");
  const periodChainId = requireHex32(opening.chain_period_id, "capacity period id");
  const processChainId = requireHex32(opening.chain_process_id, "capacity process id");
  const orderChainId = requireHex32(order.chain_order_id, "order id");
  const policyHash = requireHex32(version.policy_hash, "policy hash");
  const storedOldCommitment = BigInt(opening.capacity_commitment);
  const openingCircuitVersion = Number(opening.circuit_version);
  const jobCircuitVersion = Number(job.circuit_version);
  if (openingCircuitVersion !== jobCircuitVersion) {
    throw new StaleCanonicalCapacityError("Proof job circuit version no longer matches the private capacity opening.");
  }

  await assertCanonicalCapacityOpening({
    rpcUrl: env.THREADPROOF_RPC_URL,
    vaultAddress: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address,
    expectedChainId: env.THREADPROOF_CHAIN_ID,
    expected: {
      factoryOrganizationId: factoryChainId,
      periodId: periodChainId,
      processId: processChainId,
      activeCommitment: storedOldCommitment,
      capacityCredentialId: capacityCredentialChainId,
      policyHash,
      circuitVersion: jobCircuitVersion,
    },
  });
  await lease.renewNow();

  const factorySecret = secrets.get(factoryChainId.toLowerCase());
  if (factorySecret == null) throw new Error(`No nullifier secret configured for factory ${factoryChainId}`);
  if (factorySecret <= 0n || factorySecret >= SNARK_FIELD) {
    throw new Error("Factory nullifier secret is outside the BN254 scalar field");
  }

  const previousCapacity = scalarFromEncrypted(opening.encrypted_remaining_capacity, key, "remaining capacity");
  const oldRandomness = scalarFromEncrypted(opening.encrypted_randomness, key, "capacity randomness");
  if (previousCapacity > UINT64_MAX) throw new Error("Stored remaining capacity exceeds the circuit uint64 range");

  const orderPayloadText = decryptDetached(
    byteaToBuffer(version.confidential_payload_ciphertext),
    byteaToBuffer(version.payload_nonce),
    key,
  );
  const orderPayload = orderPayloadSchema.parse(JSON.parse(orderPayloadText));
  const orderWorkload = BigInt(orderPayload.orderWorkload);
  const orderRandomness = BigInt(orderPayload.orderRandomness);
  if (orderWorkload > UINT64_MAX) throw new Error("Order workload exceeds the circuit uint64 range");
  if (orderWorkload > previousCapacity) {
    throw new Error("Order is infeasible against the current private capacity opening");
  }

  const newCapacity = previousCapacity - orderWorkload;
  const newRandomness = randomFieldElement();
  const poseidon = await buildPoseidon();
  const hash = (values: bigint[]) => BigInt(poseidon.F.toString(poseidon(values)));

  const factoryField = fieldFromBytes32(factoryChainId);
  const periodField = fieldFromBytes32(periodChainId);
  const processField = fieldFromBytes32(processChainId);
  const orderField = fieldFromBytes32(orderChainId);
  const policyField = fieldFromBytes32(policyHash);

  const expectedOldCommitment = hash([
    factoryField,
    periodField,
    processField,
    policyField,
    previousCapacity,
    oldRandomness,
    1n,
  ]);
  if (expectedOldCommitment !== storedOldCommitment) {
    throw new Error("Private opening does not open the mirrored current capacity commitment");
  }

  const expectedOrderCommitment = hash([orderField, orderWorkload, orderRandomness, 2n]);
  const anchoredOrderCommitment = BigInt(version.order_commitment);
  if (expectedOrderCommitment !== anchoredOrderCommitment) {
    throw new Error("Encrypted order payload does not open the current order commitment");
  }

  const newCapacityCommitment = hash([
    factoryField,
    periodField,
    processField,
    policyField,
    newCapacity,
    newRandomness,
    1n,
  ]);
  const nullifier = hash([expectedOldCommitment, factorySecret, 3n]);

  const circuitInput: Record<string, string> = {
    factoryId: factoryField.toString(),
    periodId: periodField.toString(),
    processId: processField.toString(),
    orderId: orderField.toString(),
    policyHash: policyField.toString(),
    oldCapacityCommitment: expectedOldCommitment.toString(),
    newCapacityCommitment: newCapacityCommitment.toString(),
    orderCommitment: expectedOrderCommitment.toString(),
    nullifier: nullifier.toString(),
    previousCapacity: previousCapacity.toString(),
    newCapacity: newCapacity.toString(),
    orderWorkload: orderWorkload.toString(),
    oldRandomness: oldRandomness.toString(),
    newRandomness: newRandomness.toString(),
    orderRandomness: orderRandomness.toString(),
    factoryNullifierSecret: factorySecret.toString(),
  };

  await lease.renewNow();
  const { proof, publicSignals } = await groth16.fullProve(
    circuitInput,
    env.THREADPROOF_CAPACITY_WASM_PATH,
    env.THREADPROOF_CAPACITY_ZKEY_PATH,
  );
  // fullProve can be CPU-heavy enough to delay the JS timer; synchronously re-assert
  // ownership before any generated secret material is persisted.
  await lease.renewNow();

  const expectedSignals = [
    factoryField,
    periodField,
    processField,
    orderField,
    policyField,
    expectedOldCommitment,
    newCapacityCommitment,
    expectedOrderCommitment,
    nullifier,
  ].map((value) => value.toString());

  if (
    publicSignals.length !== expectedSignals.length ||
    publicSignals.some((value, index) => value !== expectedSignals[index])
  ) {
    throw new Error("Prover returned public signals that do not match the requested state transition");
  }

  if (env.THREADPROOF_CAPACITY_VKEY_PATH) {
    const verificationKey = JSON.parse(await readFile(env.THREADPROOF_CAPACITY_VKEY_PATH, "utf8"));
    if (!(await groth16.verify(verificationKey, publicSignals, proof))) {
      throw new Error("Generated proof failed local verification");
    }
  }
  await lease.renewNow();

  const nextCapacityCiphertext = encryptEmbedded(newCapacity.toString(), key);
  const nextRandomnessCiphertext = encryptEmbedded(newRandomness.toString(), key);
  const publicInputs = {
    signals: publicSignals,
    request: {
      factoryOrganizationId: factoryChainId,
      periodId: periodChainId,
      processId: processChainId,
      orderId: orderChainId,
      policyHash,
      circuitVersion: job.circuit_version,
    },
  };

  const { data: finalized, error: finalizeError } = await supabase.rpc("finalize_proof_generation", {
    target_job_id: job.id,
    target_worker_claim_token: job.worker_claim_token,
    generated_proof: proof,
    generated_public_inputs: publicInputs,
    next_capacity_ciphertext: bufferToBytea(nextCapacityCiphertext),
    next_randomness_ciphertext: bufferToBytea(nextRandomnessCiphertext),
  });
  if (finalizeError) throw finalizeError;
  if (finalized !== true) {
    throw new WorkerClaimLostError(`Proof job ${job.id} claim was lost before atomic finalization.`);
  }

  console.log(`Generated PoFC proof for job ${job.id}: ${commitmentHex(newCapacityCommitment)}`);
}

async function markStaleClaimedJob(
  supabase: ServiceClient,
  job: Row,
  error: StaleCanonicalCapacityError,
) {
  await supabase
    .from("proof_jobs")
    .update({
      status: "stale",
      error_code: "CANONICAL_CAPACITY_STALE",
      error_detail: error.message.slice(0, 4000),
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
    })
    .eq("id", job.id)
    .eq("status", "generating")
    .eq("worker_claim_token", job.worker_claim_token);
}

async function failClaimedJob(supabase: ServiceClient, job: Row, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await supabase
    .from("proof_jobs")
    .update({
      status: "failed",
      error_code: "PROOF_GENERATION_FAILED",
      error_detail: message.slice(0, 4000),
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
    })
    .eq("id", job.id)
    .eq("status", "generating")
    .eq("worker_claim_token", job.worker_claim_token);
}

async function runOnce(
  supabase: ServiceClient,
  leaseSeconds: number,
  heartbeatSeconds: number,
) {
  await releaseStaleClaims(supabase, leaseSeconds);
  const job = await claimQueuedJob(supabase);
  if (!job) return false;

  const lease = startClaimLease({
    heartbeatSeconds,
    label: `proof job ${job.id}`,
    renew: () => renewProofClaim(supabase, job),
  });

  try {
    await lease.renewNow();
    await generateProof(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) {
      console.warn(`Discarded proof work after losing job ${job.id} ownership: ${error.message}`);
      return true;
    }
    if (error instanceof StaleCanonicalCapacityError) {
      await markStaleClaimedJob(supabase, job, error);
      console.warn(`Proof job ${job.id} became stale before proving: ${error.message}`);
      return true;
    }
    await failClaimedJob(supabase, job, error);
    throw error;
  } finally {
    lease.stop();
  }
  return true;
}

async function main() {
  const env = getProofEnv();
  if (env.THREADPROOF_SIGNER_MODE !== "disabled") {
    throw new Error("Proof generation must run with THREADPROOF_SIGNER_MODE=disabled.");
  }

  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const once = process.env.THREADPROOF_RUN_ONCE === "true";
  console.log("ThreadProof proof generator started; transaction signing is structurally disabled");

  do {
    const worked = await runOnce(
      supabase,
      env.THREADPROOF_WORKER_LEASE_SECONDS,
      env.THREADPROOF_WORKER_HEARTBEAT_SECONDS,
    );
    if (!worked && !once) await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (!once);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
