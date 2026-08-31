import {
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  toBytes,
  type Hex,
  type Log,
} from "viem";
import { protocolEventsAbi } from "./chain.js";
import { getIndexerEnv } from "./env.js";
import {
  IndexerCanonicalityError,
  assertCursorBlockHash,
  nextIndexerRange,
  safeIndexerHead,
  type IndexerCursor,
} from "./indexer-cursor.js";
import { createServiceClient } from "./supabase.js";

const CAPACITY_CREDENTIAL_TYPE = keccak256(toBytes("CAPACITY_CREDENTIAL"));
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

type ServiceClient = ReturnType<typeof createServiceClient>;
type Decoded = { eventName: string; args: Record<string, unknown> };

function serialize(value: unknown): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

function asHex(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("0x")) throw new Error("Expected hex event argument");
  return value;
}

function asNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Event integer exceeds JavaScript safe integer range");
  return number;
}

function statusFromOrganization(value: unknown) {
  return ({ 1: "active", 2: "suspended", 3: "revoked" } as Record<number, string>)[asNumber(value)] ?? null;
}

function statusFromCredential(value: unknown) {
  return ({ 1: "active", 2: "suspended", 3: "revoked" } as Record<number, string>)[asNumber(value)] ?? null;
}

function commitmentHex(value: unknown) {
  const scalar = BigInt(String(value));
  return `0x${scalar.toString(16)}`;
}

function sameHex(left: unknown, right: unknown) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function decode(log: Log): Decoded | null {
  try {
    return decodeEventLog({
      abi: protocolEventsAbi as any,
      data: log.data,
      topics: log.topics,
      strict: false,
    }) as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
}

async function mirrorOrganizationStatus(supabase: ServiceClient, args: Record<string, unknown>) {
  const status = statusFromOrganization(args.newStatus);
  if (!status) return;
  await supabase
    .from("organizations")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("chain_organization_id", asHex(args.organizationId));
}

async function failCertificationJob(supabase: ServiceClient, jobId: string, code: string, detail: string) {
  const { error } = await supabase.from("capacity_certification_jobs").update({
    status: "failed",
    error_code: code,
    error_detail: detail,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
  if (error) throw error;
}

async function mirrorCredentialIssued(
  supabase: ServiceClient,
  args: Record<string, unknown>,
  txHash: string,
  blockNumber: number,
) {
  const credentialId = asHex(args.credentialId);
  const subjectChainId = asHex(args.subjectOrganizationId);
  const issuerChainId = asHex(args.issuerOrganizationId);
  const [{ data: subject }, { data: issuer }] = await Promise.all([
    supabase.from("organizations").select("id").eq("chain_organization_id", subjectChainId).maybeSingle(),
    supabase.from("organizations").select("id").eq("chain_organization_id", issuerChainId).maybeSingle(),
  ]);
  if (!subject || !issuer) {
    console.warn(`Credential ${credentialId} references organization(s) not yet linked in Postgres`);
    return;
  }

  const credentialTypeHex = asHex(args.credentialType);
  const isCapacityCredential = credentialTypeHex.toLowerCase() === CAPACITY_CREDENTIAL_TYPE.toLowerCase();
  const credentialType = isCapacityCredential ? "CAPACITY_CREDENTIAL" : credentialTypeHex;
  const validFromSeconds = asNumber(args.validFrom);
  const validUntilSeconds = asNumber(args.validUntil);
  const validFrom = new Date(validFromSeconds * 1000).toISOString();
  const validUntil = new Date(validUntilSeconds * 1000).toISOString();

  const { error } = await supabase.from("credentials").upsert({
    chain_credential_id: credentialId,
    subject_organization_id: subject.id,
    issuer_organization_id: issuer.id,
    credential_type: credentialType,
    digest: asHex(args.digest),
    scope_hash: asHex(args.scopeHash),
    status: "active",
    valid_from: validFrom,
    valid_until: validUntil,
    chain_tx_hash: txHash,
  }, { onConflict: "chain_credential_id" });
  if (error) throw error;

  if (!isCapacityCredential) return;
  const { data: job, error: jobError } = await supabase
    .from("capacity_certification_jobs")
    .select("*")
    .eq("chain_credential_id", credentialId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return;

  const validFromMatches = Math.floor(new Date(job.valid_from).getTime() / 1000) === validFromSeconds;
  const validUntilMatches = Math.floor(new Date(job.valid_until).getTime() / 1000) === validUntilSeconds;
  if (
    job.factory_organization_id !== subject.id ||
    job.auditor_organization_id !== issuer.id ||
    !sameHex(job.credential_scope_hash, args.scopeHash) ||
    !sameHex(job.credential_digest, args.digest) ||
    !validFromMatches ||
    !validUntilMatches
  ) {
    await failCertificationJob(supabase, job.id, "credential_event_mismatch", "CredentialIssued did not match the staged factory, auditor, scope, digest, or validity window.");
    return;
  }

  const { error: updateError } = await supabase.from("capacity_certification_jobs").update({
    status: "credential_confirmed",
    credential_tx_hash: txHash,
    credential_block_number: blockNumber,
    error_code: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id).in("status", ["prepared", "credential_submitted", "credential_confirmed"]);
  if (updateError) throw updateError;
}

async function mirrorCredentialStatus(supabase: ServiceClient, args: Record<string, unknown>) {
  const status = statusFromCredential(args.newStatus);
  if (!status) return;
  await supabase.from("credentials").update({ status }).eq("chain_credential_id", asHex(args.credentialId));
}

async function mirrorOrderVersion(
  supabase: ServiceClient,
  args: Record<string, unknown>,
  txHash: string,
  blockNumber: number,
) {
  const chainOrderId = asHex(args.orderId);
  const version = asNumber(args.version);
  const { data: order } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("chain_order_id", chainOrderId)
    .maybeSingle();
  if (!order) {
    console.warn(`OrderVersionRecorded ${chainOrderId} has no linked application order`);
    return;
  }

  const { data: job } = await supabase
    .from("order_authorization_jobs")
    .select("*")
    .eq("purchase_order_id", order.id)
    .eq("target_version", version)
    .in("status", ["signed", "submitting", "submitted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const orderCommitment = commitmentHex(args.orderCommitment);
  const policyHash = asHex(args.policyHash);
  const versionHash = asHex(args.versionHash);

  if (job) {
    const { error: versionError } = await supabase.from("order_versions").upsert({
      purchase_order_id: order.id,
      version,
      previous_version_hash: job.previous_version_hash === `0x${"0".repeat(64)}` ? null : job.previous_version_hash,
      version_hash: versionHash,
      order_commitment: orderCommitment,
      workload_commitment: null,
      policy_hash: policyHash,
      confidential_payload_ciphertext: job.confidential_payload_ciphertext,
      payload_nonce: job.payload_nonce,
      production_period_start: job.production_period_start,
      production_period_end: job.production_period_end,
      buyer_signature: job.buyer_signature,
      created_by: job.created_by,
      chain_tx_hash: txHash,
      chain_block_number: blockNumber,
    }, { onConflict: "purchase_order_id,version" });
    if (versionError) throw versionError;

    await supabase.from("order_authorization_jobs").update({
      status: "confirmed",
      chain_tx_hash: txHash,
      chain_block_number: blockNumber,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    }).eq("id", job.id);
  }

  const { error: orderError } = await supabase.from("purchase_orders").update({
    current_version: version,
    current_order_commitment: orderCommitment,
    current_policy_hash: policyHash,
    status: "proposed",
    updated_at: new Date().toISOString(),
  }).eq("id", order.id);
  if (orderError) throw orderError;
}

async function mirrorOrderCancelled(supabase: ServiceClient, args: Record<string, unknown>) {
  await supabase.from("purchase_orders").update({
    status: "cancelled",
    updated_at: new Date().toISOString(),
  }).eq("chain_order_id", asHex(args.orderId));
}

async function mirrorCapacityCertified(
  supabase: ServiceClient,
  args: Record<string, unknown>,
  txHash: string,
  blockNumber: number,
) {
  const stateKey = asHex(args.stateKey);
  const factoryChainId = asHex(args.factoryOrganizationId);
  const credentialId = asHex(args.capacityCredentialId);
  const periodId = asHex(args.periodId);
  const processId = asHex(args.processId);
  const policyHash = asHex(args.policyHash);
  const circuitVersion = asNumber(args.circuitVersion);
  const commitment = String(args.commitment);

  const [{ data: factory, error: factoryError }, { data: job, error: jobError }, { data: credential, error: credentialError }] = await Promise.all([
    supabase.from("organizations").select("id").eq("chain_organization_id", factoryChainId).maybeSingle(),
    supabase.from("capacity_certification_jobs").select("*").eq("chain_credential_id", credentialId).maybeSingle(),
    supabase.from("credentials").select("id,subject_organization_id,issuer_organization_id,scope_hash,digest,status").eq("chain_credential_id", credentialId).maybeSingle(),
  ]);
  if (factoryError) throw factoryError;
  if (jobError) throw jobError;
  if (credentialError) throw credentialError;

  if (!job || !factory || !credential) {
    const { error: mirrorError } = await supabase.from("private_capacity_openings").update({
      chain_period_id: periodId,
      chain_process_id: processId,
      capacity_commitment: commitment,
      policy_hash: policyHash,
      circuit_version: circuitVersion,
      last_chain_block: blockNumber,
      status: "recertification_required",
      updated_at: new Date().toISOString(),
    }).eq("chain_state_key", stateKey);
    if (mirrorError) throw mirrorError;
    console.warn(`CapacityCertified ${stateKey} has no complete private certification staging context; any existing private opening was quarantined and no new witness opening was created.`);
    return;
  }

  if (
    job.factory_organization_id !== factory.id ||
    credential.subject_organization_id !== factory.id ||
    credential.issuer_organization_id !== job.auditor_organization_id ||
    credential.status !== "active" ||
    !sameHex(credential.scope_hash, job.credential_scope_hash) ||
    !sameHex(credential.digest, job.credential_digest) ||
    !sameHex(job.chain_period_id, periodId) ||
    !sameHex(job.chain_process_id, processId) ||
    !sameHex(job.policy_hash, policyHash) ||
    BigInt(job.capacity_commitment) !== BigInt(commitment) ||
    job.circuit_version !== circuitVersion
  ) {
    await failCertificationJob(supabase, job.id, "capacity_event_mismatch", "CapacityCertified did not match the staged factory, auditor credential, period, process, policy, commitment, or circuit version.");
    return;
  }

  const { error: openingError } = await supabase.from("private_capacity_openings").upsert({
    factory_organization_id: factory.id,
    capacity_credential_id: credential.id,
    period_id: job.period_label,
    process_id: job.process_label,
    chain_period_id: periodId,
    chain_process_id: processId,
    chain_state_key: stateKey,
    capacity_commitment: commitment,
    policy_hash: policyHash,
    circuit_version: circuitVersion,
    encrypted_remaining_capacity: job.encrypted_capacity,
    encrypted_randomness: job.encrypted_randomness,
    encryption_key_version: job.encryption_key_version,
    last_chain_block: blockNumber,
    status: "active",
    updated_at: new Date().toISOString(),
  }, { onConflict: "chain_state_key" });
  if (openingError) throw openingError;

  const { error: jobUpdateError } = await supabase.from("capacity_certification_jobs").update({
    status: "confirmed",
    certification_tx_hash: txHash,
    certification_block_number: blockNumber,
    error_code: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
  if (jobUpdateError) throw jobUpdateError;
}

async function mirrorCapacitySpent(
  supabase: ServiceClient,
  txHash: string,
  blockNumber: number,
) {
  await supabase.from("proof_jobs").update({
    status: "confirmed",
    chain_block_number: blockNumber,
    completed_at: new Date().toISOString(),
  }).eq("chain_tx_hash", txHash).in("status", ["submitted", "confirmed"]);
}

async function applyMirror(
  supabase: ServiceClient,
  decoded: Decoded,
  txHash: string,
  blockNumber: number,
) {
  switch (decoded.eventName) {
    case "OrganizationStatusChanged":
      return mirrorOrganizationStatus(supabase, decoded.args);
    case "CredentialIssued":
      return mirrorCredentialIssued(supabase, decoded.args, txHash, blockNumber);
    case "CredentialStatusChanged":
      return mirrorCredentialStatus(supabase, decoded.args);
    case "OrderVersionRecorded":
      return mirrorOrderVersion(supabase, decoded.args, txHash, blockNumber);
    case "OrderCancelled":
      return mirrorOrderCancelled(supabase, decoded.args);
    case "CapacityCertified":
      return mirrorCapacityCertified(supabase, decoded.args, txHash, blockNumber);
    case "CapacitySpent":
      return mirrorCapacitySpent(supabase, txHash, blockNumber);
    default:
      return;
  }
}

async function loadIndexerCursor(supabase: ServiceClient, chainId: number): Promise<IndexerCursor | null> {
  const { data, error } = await supabase
    .from("chain_indexer_cursors")
    .select("chain_id,last_block_number,last_block_hash,status")
    .eq("chain_id", chainId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (!HEX32.test(String(data.last_block_hash))) throw new Error("Stored indexer cursor block hash is malformed.");
  if (data.status !== "healthy" && data.status !== "reorg_detected") throw new Error("Stored indexer cursor status is invalid.");
  return {
    chainId: Number(data.chain_id),
    lastBlockNumber: BigInt(data.last_block_number),
    lastBlockHash: data.last_block_hash as Hex,
    status: data.status,
  };
}

async function quarantineIndexerCursor(
  supabase: ServiceClient,
  cursor: IndexerCursor | null,
  detail: string,
) {
  if (!cursor) return;
  const { error } = await supabase
    .from("chain_indexer_cursors")
    .update({
      status: "reorg_detected",
      error_code: "CHAIN_REORG_DETECTED",
      error_detail: detail.slice(0, 4000),
      updated_at: new Date().toISOString(),
    })
    .eq("chain_id", cursor.chainId)
    .eq("last_block_number", cursor.lastBlockNumber.toString())
    .eq("last_block_hash", cursor.lastBlockHash);
  if (error) throw error;
}

async function advanceIndexerCursor(
  supabase: ServiceClient,
  chainId: number,
  blockNumber: bigint,
  blockHash: Hex,
) {
  const { error } = await supabase.from("chain_indexer_cursors").upsert({
    chain_id: chainId,
    last_block_number: blockNumber.toString(),
    last_block_hash: blockHash,
    status: "healthy",
    error_code: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "chain_id" });
  if (error) throw error;
}

async function indexOnce() {
  const env = getIndexerEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const client = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000, retryCount: 2, retryDelay: 250 }) });
  const chainId = await client.getChainId();
  if (env.THREADPROOF_CHAIN_ID !== undefined && chainId !== env.THREADPROOF_CHAIN_ID) {
    throw new Error(`Canonical RPC chain ID ${chainId} does not match configured chain ID ${env.THREADPROOF_CHAIN_ID}.`);
  }

  const cursor = await loadIndexerCursor(supabase, chainId);
  if (cursor) {
    let cursorBlock;
    try {
      cursorBlock = await client.getBlock({ blockNumber: cursor.lastBlockNumber });
    } catch (error) {
      throw new Error(`Could not verify canonical indexer cursor block ${cursor.lastBlockNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      assertCursorBlockHash(cursor, cursorBlock.hash);
    } catch (error) {
      if (error instanceof IndexerCanonicalityError) {
        await quarantineIndexerCursor(supabase, cursor, error.message);
      }
      throw error;
    }
  }

  const head = await client.getBlockNumber();
  const safeHead = safeIndexerHead(head, env.THREADPROOF_CONFIRMATIONS);
  const range = nextIndexerRange({
    cursor,
    startBlock: env.THREADPROOF_INDEXER_START_BLOCK,
    safeHead,
    batchSize: env.THREADPROOF_INDEXER_BLOCK_BATCH,
  });
  if (!range) return false;

  const { fromBlock, toBlock } = range;
  const targetBefore = await client.getBlock({ blockNumber: toBlock });
  if (!targetBefore.hash) throw new Error(`Canonical RPC returned block ${toBlock} without a hash.`);

  const addresses = [
    env.THREADPROOF_REGISTRY_ADDRESS,
    env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS,
    env.THREADPROOF_ORDER_REGISTRY_ADDRESS,
    env.THREADPROOF_CAPACITY_VAULT_ADDRESS,
    env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS,
    env.THREADPROOF_CHARTER_ADDRESS,
  ] as Hex[];
  const logs = await client.getLogs({ address: addresses, fromBlock, toBlock });
  const verifiedLogBlocks = new Map<bigint, Hex>();

  for (const log of logs) {
    const decoded = decode(log);
    if (!decoded || !log.transactionHash || !log.blockHash || log.blockNumber == null || log.logIndex == null) continue;

    let canonicalLogHash = verifiedLogBlocks.get(log.blockNumber);
    if (!canonicalLogHash) {
      const canonicalBlock = await client.getBlock({ blockNumber: log.blockNumber });
      if (!canonicalBlock.hash) throw new Error(`Canonical RPC returned event block ${log.blockNumber} without a hash.`);
      canonicalLogHash = canonicalBlock.hash;
      verifiedLogBlocks.set(log.blockNumber, canonicalLogHash);
    }
    if (canonicalLogHash.toLowerCase() !== log.blockHash.toLowerCase()) {
      const error = new IndexerCanonicalityError(
        `Protocol log block ${log.blockNumber} hash ${log.blockHash} no longer matches canonical RPC hash ${canonicalLogHash}.`,
      );
      await quarantineIndexerCursor(supabase, cursor, error.message);
      throw error;
    }

    const blockNumber = Number(log.blockNumber);
    if (!Number.isSafeInteger(blockNumber)) throw new Error("Block number exceeds JavaScript safe integer range");

    const { error } = await supabase.from("chain_events").upsert({
      chain_id: chainId,
      block_number: blockNumber,
      block_hash: log.blockHash,
      transaction_hash: log.transactionHash,
      log_index: log.logIndex,
      contract_address: log.address,
      event_name: decoded.eventName,
      indexed_values: {},
      data: serialize(decoded.args),
      observed_at: new Date().toISOString(),
    }, { onConflict: "chain_id,transaction_hash,log_index" });
    if (error) throw error;

    await applyMirror(supabase, decoded, log.transactionHash, blockNumber);
  }

  const targetAfter = await client.getBlock({ blockNumber: toBlock });
  if (!targetAfter.hash || targetAfter.hash.toLowerCase() !== targetBefore.hash.toLowerCase()) {
    const error = new IndexerCanonicalityError(
      `Indexer batch-end block ${toBlock} changed while the batch was being projected.`,
    );
    await quarantineIndexerCursor(supabase, cursor, error.message);
    throw error;
  }

  await advanceIndexerCursor(supabase, chainId, toBlock, targetAfter.hash);
  console.log(
    `Indexed confirmed ThreadProof blocks ${fromBlock}-${toBlock}: ${logs.length} protocol logs; cursor=${toBlock}@${targetAfter.hash}`,
  );
  return safeHead != null && toBlock < safeHead;
}

async function main() {
  const once = process.env.THREADPROOF_RUN_ONCE === "true";
  do {
    const behind = await indexOnce();
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, behind ? 100 : 2_000));
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
