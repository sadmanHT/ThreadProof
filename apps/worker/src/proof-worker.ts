import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";
import { groth16, type Groth16Proof } from "snarkjs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { capacityVaultAbi } from "./chain.js";
import {
  bufferToBytea,
  byteaToBuffer,
  decodeDataKey,
  decryptDetached,
  decryptEmbedded,
  encryptEmbedded,
} from "./crypto.js";
import { getProofEnv, parseFactorySecrets } from "./env.js";
import { createServiceClient } from "./supabase.js";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const UINT64_MAX = (1n << 64n) - 1n;
const hex32Pattern = /^0x[0-9a-fA-F]{64}$/;

const orderPayloadSchema = z.object({
  orderWorkload: z.string().regex(/^[0-9]+$/),
  orderRandomness: z.string().regex(/^[0-9]+$/),
});

type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

type JobContext = {
  job: Row;
  opening: Row;
  version: Row;
  order: Row;
  factory: Row;
};

function requireHex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !hex32Pattern.test(value)) {
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
  // 30 bytes is always below the BN254 scalar field and gives ample entropy for commitment randomness.
  return BigInt(`0x${randomBytes(30).toString("hex")}`);
}

function commitmentHex(value: bigint) {
  return `0x${value.toString(16)}`;
}

async function releaseStaleClaims(supabase: ServiceClient) {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from("proof_jobs")
    .update({ status: "queued", worker_claim_token: null, worker_claimed_at: null })
    .eq("status", "generating")
    .lt("worker_claimed_at", cutoff);
  await supabase
    .from("proof_jobs")
    .update({ worker_claim_token: null, worker_claimed_at: null })
    .eq("status", "generated")
    .lt("worker_claimed_at", cutoff);
}

async function claimJob(supabase: ServiceClient, status: "queued" | "generated") {
  const { data: candidates, error } = await supabase
    .from("proof_jobs")
    .select("*")
    .eq("status", status)
    .is("worker_claim_token", null)
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const patch = status === "queued"
      ? { status: "generating", started_at: new Date().toISOString(), worker_claim_token: token, worker_claimed_at: new Date().toISOString() }
      : { worker_claim_token: token, worker_claimed_at: new Date().toISOString() };
    const { data, error: claimError } = await supabase
      .from("proof_jobs")
      .update(patch)
      .eq("id", candidate.id)
      .eq("status", status)
      .is("worker_claim_token", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function loadContext(supabase: ServiceClient, job: Row): Promise<JobContext> {
  const { data: opening, error: openingError } = await supabase
    .from("private_capacity_openings")
    .select("*")
    .eq("id", job.capacity_opening_id)
    .single();
  if (openingError) throw openingError;

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

  return { job, opening, version, order, factory };
}

async function generateProof(supabase: ServiceClient, job: Row) {
  const env = getProofEnv();
  const key = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);
  const secrets = parseFactorySecrets(env.THREADPROOF_FACTORY_SECRETS_JSON);
  const context = await loadContext(supabase, job);
  const { opening, version, order, factory } = context;

  const factoryChainId = requireHex32(factory.chain_organization_id, "factory chain organization id");
  const periodChainId = requireHex32(opening.chain_period_id, "capacity period id");
  const processChainId = requireHex32(opening.chain_process_id, "capacity process id");
  const orderChainId = requireHex32(order.chain_order_id, "order id");
  const policyHash = requireHex32(version.policy_hash, "policy hash");

  const factorySecret = secrets.get(factoryChainId.toLowerCase());
  if (factorySecret == null) throw new Error(`No nullifier secret configured for factory ${factoryChainId}`);
  if (factorySecret <= 0n || factorySecret >= SNARK_FIELD) throw new Error("Factory nullifier secret is outside the BN254 scalar field");

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
  if (orderWorkload > previousCapacity) throw new Error("Order is infeasible against the current private capacity opening");

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
  const storedOldCommitment = BigInt(opening.capacity_commitment);
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

  const { proof, publicSignals } = await groth16.fullProve(
    circuitInput,
    env.THREADPROOF_CAPACITY_WASM_PATH,
    env.THREADPROOF_CAPACITY_ZKEY_PATH,
  );

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

  if (publicSignals.length !== expectedSignals.length || publicSignals.some((value, index) => value !== expectedSignals[index])) {
    throw new Error("Prover returned public signals that do not match the requested state transition");
  }

  if (env.THREADPROOF_CAPACITY_VKEY_PATH) {
    const verificationKey = JSON.parse(await readFile(env.THREADPROOF_CAPACITY_VKEY_PATH, "utf8"));
    if (!(await groth16.verify(verificationKey, publicSignals, proof))) {
      throw new Error("Generated proof failed local verification");
    }
  }

  const nextCapacityCiphertext = encryptEmbedded(newCapacity.toString(), key);
  const nextRandomnessCiphertext = encryptEmbedded(newRandomness.toString(), key);

  const { error: privateStateError } = await supabase.from("proof_job_private_state").upsert({
    proof_job_id: job.id,
    next_capacity_ciphertext: bufferToBytea(nextCapacityCiphertext),
    next_randomness_ciphertext: bufferToBytea(nextRandomnessCiphertext),
  });
  if (privateStateError) throw privateStateError;

  const { error: updateError } = await supabase
    .from("proof_jobs")
    .update({
      status: "generated",
      proof,
      public_inputs: {
        signals: publicSignals,
        request: {
          factoryOrganizationId: factoryChainId,
          periodId: periodChainId,
          processId: processChainId,
          orderId: orderChainId,
          policyHash,
          circuitVersion: job.circuit_version,
        },
      },
      error_code: null,
      error_detail: null,
      worker_claim_token: null,
      worker_claimed_at: null,
    })
    .eq("id", job.id)
    .eq("worker_claim_token", job.worker_claim_token);
  if (updateError) throw updateError;

  console.log(`Generated PoFC proof for job ${job.id}: ${commitmentHex(newCapacityCommitment)}`);
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

async function finalizeConfirmedSpend(
  supabase: ServiceClient,
  context: JobContext,
  txHash: Hex,
  blockNumber: bigint,
  publicSignals: string[],
) {
  const { data: privateState, error: privateStateError } = await supabase
    .from("proof_job_private_state")
    .select("*")
    .eq("proof_job_id", context.job.id)
    .single();
  if (privateStateError) throw privateStateError;

  const [oldCommitment, newCommitment, orderCommitment, nullifier] = publicSignals.slice(5).map(BigInt);
  if (oldCommitment == null || newCommitment == null || orderCommitment == null || nullifier == null) {
    throw new Error("Confirmed proof is missing capacity public signals");
  }

  const confirmedAt = new Date().toISOString();
  const block = Number(blockNumber);
  if (!Number.isSafeInteger(block)) throw new Error("Block number exceeds JavaScript safe integer range");

  const { error: openingError } = await supabase
    .from("private_capacity_openings")
    .update({
      capacity_commitment: newCommitment.toString(),
      encrypted_remaining_capacity: privateState.next_capacity_ciphertext,
      encrypted_randomness: privateState.next_randomness_ciphertext,
      last_chain_block: block,
      status: "active",
      updated_at: confirmedAt,
    })
    .eq("id", context.opening.id)
    .eq("capacity_commitment", oldCommitment.toString());
  if (openingError) throw openingError;

  const { error: allocationError } = await supabase.from("capacity_allocations").upsert({
    capacity_opening_id: context.opening.id,
    order_version_id: context.version.id,
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
      worker_claim_token: null,
      worker_claimed_at: null,
    })
    .eq("id", context.job.id);
  if (jobError) throw jobError;

  await supabase.from("proof_job_private_state").delete().eq("proof_job_id", context.job.id);
}

async function submitGeneratedProof(supabase: ServiceClient, job: Row) {
  const env = getProofEnv();
  if (!env.THREADPROOF_RELAYER_PRIVATE_KEY) {
    await supabase.from("proof_jobs").update({ worker_claim_token: null, worker_claimed_at: null }).eq("id", job.id);
    return;
  }

  const context = await loadContext(supabase, job);
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

  const account = privateKeyToAccount(env.THREADPROOF_RELAYER_PRIVATE_KEY as Hex);
  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "ThreadProof Besu",
    nativeCurrency: { name: "ThreadProof Gas", symbol: "TPG", decimals: 18 },
    rpcUrls: { default: { http: [env.THREADPROOF_RPC_URL] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(env.THREADPROOF_RPC_URL) });

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
    circuitVersion: Number(context.job.circuit_version),
  } as const;

  try {
    const txHash = await wallet.writeContract({
      address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Hex,
      abi: capacityVaultAbi,
      functionName: "spendCapacity",
      args: [spendRequest, a, b, c],
    });
    await supabase.from("proof_jobs").update({
      status: "submitted",
      chain_tx_hash: txHash,
      worker_claim_token: null,
      worker_claimed_at: null,
    }).eq("id", job.id);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`Capacity spend transaction reverted: ${txHash}`);
    await finalizeConfirmedSpend(supabase, context, txHash, receipt.blockNumber, publicSignals);
    console.log(`Confirmed PoFC spend for job ${job.id} in block ${receipt.blockNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stale = /StaleCapacityState|NullifierAlreadyUsed|InvalidOrderAuthorization/.test(message);
    await supabase.from("proof_jobs").update({
      status: stale ? "stale" : "failed",
      error_code: stale ? "CHAIN_STATE_STALE" : "CHAIN_SUBMISSION_FAILED",
      error_detail: message.slice(0, 4000),
      completed_at: new Date().toISOString(),
      worker_claim_token: null,
      worker_claimed_at: null,
    }).eq("id", job.id);
    throw error;
  }
}

async function failClaimedJob(supabase: ServiceClient, job: Row, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await supabase.from("proof_jobs").update({
    status: "failed",
    error_code: "PROOF_WORKER_FAILED",
    error_detail: message.slice(0, 4000),
    completed_at: new Date().toISOString(),
    worker_claim_token: null,
    worker_claimed_at: null,
  }).eq("id", job.id);
}

async function runOnce() {
  const env = getProofEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  await releaseStaleClaims(supabase);

  const queued = await claimJob(supabase, "queued");
  if (queued) {
    try {
      await generateProof(supabase, queued);
    } catch (error) {
      await failClaimedJob(supabase, queued, error);
      throw error;
    }
    return true;
  }

  if (env.THREADPROOF_RELAYER_PRIVATE_KEY) {
    const generated = await claimJob(supabase, "generated");
    if (generated) {
      try {
        await submitGeneratedProof(supabase, generated);
      } catch (error) {
        console.error(error);
      }
      return true;
    }
  }
  return false;
}

async function main() {
  const once = process.env.THREADPROOF_RUN_ONCE === "true";
  do {
    const worked = await runOnce();
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, worked ? 250 : 3_000));
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
