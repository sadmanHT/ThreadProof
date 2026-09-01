import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import {
  orderRegistryAbi,
  subcontractGovernorAbi,
  threadProofRegistryAbi,
} from "./chain.js";
import { getSubcontractRelayerEnv } from "./env.js";
import {
  WorkerClaimLostError,
  staleClaimCutoffIso,
  startClaimLease,
} from "./job-lease.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const TABLE = "subcontract_authorization_jobs";

const subcontractTypes = {
  SubcontractAuthorization: [
    { name: "parentOrderId", type: "bytes32" },
    { name: "childOrderId", type: "bytes32" },
    { name: "parentFactoryOrganizationId", type: "bytes32" },
    { name: "subcontractorOrganizationId", type: "bytes32" },
    { name: "periodId", type: "bytes32" },
    { name: "processId", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "parentVersionHash", type: "bytes32" },
    { name: "childVersionHash", type: "bytes32" },
    { name: "complianceCredentialId", type: "bytes32" },
    { name: "processCredentialId", type: "bytes32" },
    { name: "capacityAllocationId", type: "bytes32" },
    { name: "sequence", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;

class StaleSubcontractError extends Error {}
class BroadcastPersistenceError extends Error {
  constructor(readonly txHash: Hex, message: string) {
    super(message);
    this.name = "BroadcastPersistenceError";
  }
}

function hex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new Error(`${label} is not bytes32 hex`);
  return value as Hex;
}

function errorDetail(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 1800 ? `${value.slice(0, 1800)}…` : value;
}

function isContractRevert(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const item = error as { name?: unknown; shortMessage?: unknown; message?: unknown };
  return item.name === "ContractFunctionExecutionError"
    || (typeof item.shortMessage === "string" && item.shortMessage.toLowerCase().includes("revert"))
    || (typeof item.message === "string" && item.message.includes("ContractFunctionRevertedError"));
}

function eventField(data: unknown, key: string) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function sameHex(left: unknown, right: unknown) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "ThreadProof SubcontractGovernor",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

async function releaseAbandonedClaims(supabase: ServiceClient, leaseSeconds: number) {
  const cutoff = staleClaimCutoffIso(leaseSeconds);
  const now = new Date().toISOString();
  const { error: releaseError } = await supabase
    .from(TABLE)
    .update({ status: "signed", worker_claim_token: null, worker_claimed_at: null, updated_at: now })
    .eq("status", "submitting")
    .is("chain_tx_hash", null)
    .lt("worker_claimed_at", cutoff);
  if (releaseError) throw releaseError;

  const { error: deadlineError } = await supabase
    .from(TABLE)
    .update({
      status: "stale",
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: now,
      error_code: "DEADLINE_EXPIRED",
      error_detail: "Parent-factory subcontract authorization expired before relay.",
    })
    .in("status", ["prepared", "signed"])
    .lt("deadline", now);
  if (deadlineError) throw deadlineError;
}

async function claimSignedJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "signed")
    .is("worker_claim_token", null)
    .gt("deadline", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(8);
  if (error) throw error;

  for (const candidate of candidates ?? []) {
    const token = randomUUID();
    const now = new Date().toISOString();
    const { data, error: claimError } = await supabase
      .from(TABLE)
      .update({
        status: "submitting",
        worker_claim_token: token,
        worker_claimed_at: now,
        updated_at: now,
        error_code: null,
        error_detail: null,
      })
      .eq("id", candidate.id)
      .eq("status", "signed")
      .is("worker_claim_token", null)
      .select("*")
      .maybeSingle();
    if (claimError) throw claimError;
    if (data) return data as Row;
  }
  return null;
}

async function renewClaim(supabase: ServiceClient, job: Row, token: string) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ worker_claimed_at: now, updated_at: now })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

async function markStale(supabase: ServiceClient, job: Row, token: string, code: string, detail: string) {
  await supabase
    .from(TABLE)
    .update({
      status: "stale",
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: code,
      error_detail: detail,
    })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token);
}

async function releaseForSignerRetry(supabase: ServiceClient, job: Row, token: string, error: RelayerSignerUnavailableError) {
  await supabase
    .from(TABLE)
    .update({
      status: "signed",
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: "SIGNER_UNAVAILABLE",
      error_detail: error.message,
    })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token);
}

async function persistBroadcast(supabase: ServiceClient, job: Row, token: string, txHash: Hex) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: "submitted",
      chain_tx_hash: txHash,
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token)
    .select("id")
    .maybeSingle();
  if (error) throw new BroadcastPersistenceError(txHash, `Broadcast ${txHash} could not be persisted: ${error.message}`);
  if (!data) throw new WorkerClaimLostError(`Subcontract job ${job.id} claim was lost after broadcasting ${txHash}.`);
}

async function observeReceipt(
  supabase: ServiceClient,
  job: Row,
  txHash: Hex,
  publicClient: ReturnType<typeof createPublicClient>,
) {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") {
      await supabase.from(TABLE).update({
        status: "failed",
        chain_block_number: Number(receipt.blockNumber),
        updated_at: new Date().toISOString(),
        error_code: "CHAIN_TRANSACTION_REVERTED",
        error_detail: `SubcontractGovernor transaction reverted: ${txHash}`,
      }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
      return;
    }

    // Canonical confirmation is event-driven. A receipt records only the observed block;
    // the job stays submitted until the confirmation-adjusted indexer mirrors the exact event.
    await supabase.from(TABLE).update({
      chain_block_number: Number(receipt.blockNumber),
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
  } catch (error) {
    await supabase.from(TABLE).update({
      updated_at: new Date().toISOString(),
      error_code: "CHAIN_CONFIRMATION_PENDING",
      error_detail: errorDetail(error),
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
  }
}

async function reconcileSubmittedJobs(
  supabase: ServiceClient,
  publicClient: ReturnType<typeof createPublicClient>,
) {
  const { data: jobs, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "submitted")
    .not("chain_tx_hash", "is", null)
    .order("updated_at", { ascending: true })
    .limit(40);
  if (error) throw error;

  for (const job of jobs ?? []) {
    const txHash = job.chain_tx_hash as Hex;
    const { data: event, error: eventError } = await supabase
      .from("chain_events")
      .select("data,block_number,transaction_hash")
      .eq("transaction_hash", txHash)
      .eq("event_name", "SubcontractAuthorized")
      .limit(1)
      .maybeSingle();
    if (eventError) throw eventError;

    if (!event) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt.status === "reverted") {
          await supabase.from(TABLE).update({
            status: "failed",
            chain_block_number: Number(receipt.blockNumber),
            updated_at: new Date().toISOString(),
            error_code: "CHAIN_TRANSACTION_REVERTED",
            error_detail: `SubcontractGovernor transaction reverted: ${txHash}`,
          }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
        }
      } catch {
        // Receipt or confirmed event is not available yet. Keep the job submitted.
      }
      continue;
    }

    const [{ data: parentFactory }, { data: subcontractor }, { data: buyer }] = await Promise.all([
      supabase.from("organizations").select("chain_organization_id").eq("id", job.parent_factory_organization_id).maybeSingle(),
      supabase.from("organizations").select("chain_organization_id").eq("id", job.subcontractor_organization_id).maybeSingle(),
      supabase.from("organizations").select("chain_organization_id").eq("id", job.buyer_organization_id).maybeSingle(),
    ]);
    const matches = !!parentFactory && !!subcontractor && !!buyer
      && sameHex(eventField(event.data, "childOrderId"), job.child_chain_order_id)
      && sameHex(eventField(event.data, "parentOrderId"), job.parent_chain_order_id)
      && sameHex(eventField(event.data, "subcontractorOrganizationId"), subcontractor.chain_organization_id)
      && sameHex(eventField(event.data, "buyerOrganizationId"), buyer.chain_organization_id)
      && sameHex(eventField(event.data, "parentFactoryOrganizationId"), parentFactory.chain_organization_id)
      && Number(eventField(event.data, "sequence")) === Number(job.sequence)
      && sameHex(eventField(event.data, "capacityAllocationId"), job.chain_capacity_allocation_id);

    if (!matches) {
      await supabase.from(TABLE).update({
        status: "failed",
        chain_block_number: Number(event.block_number),
        updated_at: new Date().toISOString(),
        error_code: "SUBCONTRACT_EVENT_MISMATCH",
        error_detail: "Indexed SubcontractAuthorized event did not match the staged child, parent, parties, sequence, or capacity allocation.",
      }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
      continue;
    }

    await supabase.from(TABLE).update({
      status: "confirmed",
      chain_block_number: Number(event.block_number),
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    }).eq("id", job.id).eq("status", "submitted").eq("chain_tx_hash", txHash);
  }
}

async function canonicalClient() {
  const env = getSubcontractRelayerEnv();
  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) {
    throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);
  }
  return { env, publicClient, chainId };
}

async function relaySubcontract(supabase: ServiceClient, job: Row, lease: ReturnType<typeof startClaimLease>) {
  const token = String(job.worker_claim_token);
  if (!SIGNATURE.test(String(job.parent_factory_signature))) throw new Error("Parent-factory signature is missing or malformed");
  if (new Date(job.deadline).getTime() <= Date.now()) throw new StaleSubcontractError("Subcontract authorization deadline expired");

  const [{ data: parentFactory, error: parentFactoryError }, { data: subcontractor, error: subcontractorError }] = await Promise.all([
    supabase.from("organizations").select("chain_organization_id,status,role").eq("id", job.parent_factory_organization_id).single(),
    supabase.from("organizations").select("chain_organization_id,status,role").eq("id", job.subcontractor_organization_id).single(),
  ]);
  if (parentFactoryError) throw parentFactoryError;
  if (subcontractorError) throw subcontractorError;
  if (parentFactory.status !== "active" || parentFactory.role !== "factory" || subcontractor.status !== "active" || subcontractor.role !== "factory") {
    throw new StaleSubcontractError("Parent factory or subcontractor is no longer an active factory in the application mirror");
  }

  const parentFactoryOrganizationId = hex32(parentFactory.chain_organization_id, "parent factory organization id");
  const subcontractorOrganizationId = hex32(subcontractor.chain_organization_id, "subcontractor organization id");
  const authorization = {
    parentOrderId: hex32(job.parent_chain_order_id, "parent order id"),
    childOrderId: hex32(job.child_chain_order_id, "child order id"),
    parentFactoryOrganizationId,
    subcontractorOrganizationId,
    periodId: hex32(job.period_id, "period id"),
    processId: hex32(job.process_id, "process id"),
    policyHash: hex32(job.policy_hash, "policy hash"),
    parentVersionHash: hex32(job.parent_version_hash, "parent version hash"),
    childVersionHash: hex32(job.child_version_hash, "child version hash"),
    complianceCredentialId: hex32(job.chain_compliance_credential_id, "compliance credential id"),
    processCredentialId: hex32(job.chain_process_credential_id, "process credential id"),
    capacityAllocationId: hex32(job.chain_capacity_allocation_id, "capacity allocation id"),
    sequence: Number(job.sequence),
    nonce: BigInt(job.nonce),
    deadline: BigInt(Math.floor(new Date(job.deadline).getTime() / 1000)),
  } as const;

  const { env, publicClient, chainId } = await canonicalClient();
  const signature = job.parent_factory_signature as Hex;
  const signer = await recoverTypedDataAddress({
    domain: domain(chainId, env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS as `0x${string}`),
    types: subcontractTypes,
    primaryType: "SubcontractAuthorization",
    message: authorization,
    signature,
  });

  const [signerOrganization, signerActive, currentNonce, parentState, childState] = await Promise.all([
    publicClient.readContract({ address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`, abi: threadProofRegistryAbi, functionName: "organizationOfAccount", args: [signer] }),
    publicClient.readContract({ address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`, abi: threadProofRegistryAbi, functionName: "isActiveAccount", args: [signer] }),
    publicClient.readContract({ address: env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS as `0x${string}`, abi: subcontractGovernorAbi, functionName: "nonces", args: [parentFactoryOrganizationId] }),
    publicClient.readContract({ address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`, abi: orderRegistryAbi, functionName: "getOrder", args: [authorization.parentOrderId] }),
    publicClient.readContract({ address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`, abi: orderRegistryAbi, functionName: "getOrder", args: [authorization.childOrderId] }),
  ]);

  if (!signerActive || signerOrganization.toLowerCase() !== parentFactoryOrganizationId.toLowerCase()) {
    throw new StaleSubcontractError("Recovered signer is not an active account for the parent factory organization");
  }
  if (currentNonce !== authorization.nonce) {
    throw new StaleSubcontractError(`Parent-factory nonce advanced from ${authorization.nonce} to ${currentNonce}`);
  }
  if (
    parentState.status !== 1
    || parentState.primaryFactoryOrganizationId.toLowerCase() !== parentFactoryOrganizationId.toLowerCase()
    || parentState.currentVersion !== Number(job.parent_version)
    || parentState.currentVersionHash.toLowerCase() !== authorization.parentVersionHash.toLowerCase()
    || parentState.currentPolicyHash.toLowerCase() !== authorization.policyHash.toLowerCase()
  ) {
    throw new StaleSubcontractError("Parent OrderRegistry state no longer matches the signed subcontract context");
  }
  if (
    childState.status !== 1
    || childState.primaryFactoryOrganizationId.toLowerCase() !== subcontractorOrganizationId.toLowerCase()
    || childState.currentVersion !== Number(job.child_version)
    || childState.currentVersionHash.toLowerCase() !== authorization.childVersionHash.toLowerCase()
    || childState.currentPolicyHash.toLowerCase() !== authorization.policyHash.toLowerCase()
    || childState.buyerOrganizationId.toLowerCase() !== parentState.buyerOrganizationId.toLowerCase()
  ) {
    throw new StaleSubcontractError("Child OrderRegistry state no longer matches the signed subcontract context");
  }

  await lease.renewNow();
  const { account, wallet } = await createRelayerWallet(env, chainId);
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS as `0x${string}`,
      abi: subcontractGovernorAbi,
      functionName: "authorizeSubcontract",
      args: [authorization, signature],
      account,
    }));
  } catch (error) {
    if (isContractRevert(error)) throw new StaleSubcontractError(`SubcontractGovernor rejected the signed authorization: ${errorDetail(error)}`);
    throw error;
  }
  await lease.renewNow();
  const txHash = await wallet.writeContract(request);

  lease.stop();
  await persistBroadcast(supabase, job, token, txHash);
  await observeReceipt(supabase, job, txHash, publicClient);
}

async function processJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const token = String(job.worker_claim_token);
  const lease = startClaimLease({
    heartbeatSeconds,
    label: `subcontract authorization job ${job.id}`,
    renew: () => renewClaim(supabase, job, token),
  });

  try {
    await lease.renewNow();
    await relaySubcontract(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) {
      console.warn(`Stopped subcontract job ${job.id} after claim loss: ${error.message}`);
      return;
    }
    if (error instanceof BroadcastPersistenceError) {
      console.error(`Subcontract job ${job.id} broadcast ${error.txHash} but persistence failed; canonical event indexing may still recover it: ${error.message}`);
      return;
    }
    if (error instanceof StaleSubcontractError) {
      await markStale(supabase, job, token, "SUBCONTRACT_AUTH_STALE", error.message);
      return;
    }
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, job, token, error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return;
    }

    const { data: latest } = await supabase.from(TABLE).select("status").eq("id", job.id).maybeSingle();
    if (latest?.status === "confirmed" || latest?.status === "submitted") return;
    await supabase.from(TABLE).update({
      status: "failed",
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: "SUBCONTRACT_RELAY_FAILED",
      error_detail: errorDetail(error),
    }).eq("id", job.id).eq("status", "submitting").eq("worker_claim_token", token);
  } finally {
    lease.stop();
  }
}

async function main() {
  const env = getSubcontractRelayerEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { publicClient: reconciliationClient } = await canonicalClient();
  console.log(`ThreadProof subcontract relayer started with ${env.THREADPROOF_SIGNER_MODE} signing`);
  while (true) {
    await releaseAbandonedClaims(supabase, env.THREADPROOF_WORKER_LEASE_SECONDS);
    await reconcileSubmittedJobs(supabase, reconciliationClient);
    const job = await claimSignedJob(supabase);
    if (job) {
      await processJob(supabase, job, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
