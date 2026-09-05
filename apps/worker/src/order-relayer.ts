import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  hashTypedData,
  http,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { orderRegistryAbi, threadProofRegistryAbi } from "./chain.js";
import { getOrderRelayerEnv } from "./env.js";
import {
  type ClaimLease,
  WorkerClaimLostError,
  staleClaimCutoffIso,
  startClaimLease,
} from "./job-lease.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

const orderVersionTypes = {
  OrderVersion: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "primaryFactoryOrganizationId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "previousVersionHash", type: "bytes32" },
    { name: "orderCommitment", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const cancelOrderTypes = {
  CancelOrder: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "expectedVersion", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

type ServiceClient = ReturnType<typeof createServiceClient>;
type Row = Record<string, any>;
type JobTable = "order_authorization_jobs" | "order_cancellation_jobs";

class StaleAuthorizationError extends Error {}
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
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1800 ? `${message.slice(0, 1800)}…` : message;
}

function orderRegistryDomain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

function assertSignedDomainBinding(
  job: Row,
  chainId: number,
  orderRegistryAddress: `0x${string}`,
  recomputedDigest: Hex,
  label: string,
) {
  const signedChainId = Number(job.signed_chain_id);
  if (!Number.isSafeInteger(signedChainId) || signedChainId !== chainId) {
    throw new StaleAuthorizationError(`${label} signed chain ID does not match the relayer RPC chain`);
  }

  const signedRegistry = String(job.signed_order_registry_address ?? "");
  if (!ADDRESS.test(signedRegistry) || signedRegistry.toLowerCase() !== orderRegistryAddress.toLowerCase()) {
    throw new StaleAuthorizationError(`${label} signed OrderRegistry address does not match the relayer deployment`);
  }

  const signedDigest = String(job.signed_typed_data_hash ?? "");
  if (!HEX32.test(signedDigest) || signedDigest.toLowerCase() !== recomputedDigest.toLowerCase()) {
    throw new StaleAuthorizationError(`${label} stored EIP-712 digest does not match the reconstructed signed payload`);
  }
}

async function persistValidatedSigner(
  supabase: ServiceClient,
  table: JobTable,
  job: Row,
  token: string,
  signer: `0x${string}`,
) {
  const { data, error } = await supabase
    .from(table)
    .update({ validated_buyer_signer: signer, updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new WorkerClaimLostError(`${table} job ${job.id} claim was lost before validated signer evidence could be persisted.`);
  }
}

async function releaseAbandonedClaims(supabase: ServiceClient, leaseSeconds: number) {
  const cutoff = staleClaimCutoffIso(leaseSeconds);
  const now = new Date().toISOString();

  const { error: authReleaseError } = await supabase
    .from("order_authorization_jobs")
    .update({ status: "signed", worker_claim_token: null, worker_claimed_at: null, updated_at: now })
    .eq("status", "submitting")
    .is("chain_tx_hash", null)
    .lt("worker_claimed_at", cutoff);
  if (authReleaseError) throw authReleaseError;

  const { error: cancelReleaseError } = await supabase
    .from("order_cancellation_jobs")
    .update({ status: "signed", worker_claim_token: null, worker_claimed_at: null, updated_at: now })
    .eq("status", "submitting")
    .is("chain_tx_hash", null)
    .lt("worker_claimed_at", cutoff);
  if (cancelReleaseError) throw cancelReleaseError;

  const { error: authDeadlineError } = await supabase
    .from("order_authorization_jobs")
    .update({ status: "stale", worker_claim_token: null, worker_claimed_at: null, updated_at: now, error_code: "DEADLINE_EXPIRED", error_detail: "Buyer authorization deadline expired before relay." })
    .in("status", ["prepared", "signed"])
    .lt("deadline", now);
  if (authDeadlineError) throw authDeadlineError;

  const { error: cancelDeadlineError } = await supabase
    .from("order_cancellation_jobs")
    .update({ status: "stale", worker_claim_token: null, worker_claimed_at: null, updated_at: now, error_code: "DEADLINE_EXPIRED", error_detail: "Buyer cancellation deadline expired before relay." })
    .in("status", ["prepared", "signed"])
    .lt("deadline", now);
  if (cancelDeadlineError) throw cancelDeadlineError;
}

async function claimSignedAuthorizationJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase
    .from("order_authorization_jobs")
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
      .from("order_authorization_jobs")
      .update({ status: "submitting", worker_claim_token: token, worker_claimed_at: now, updated_at: now, error_code: null, error_detail: null })
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

async function claimSignedCancellationJob(supabase: ServiceClient) {
  const { data: candidates, error } = await supabase
    .from("order_cancellation_jobs")
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
      .from("order_cancellation_jobs")
      .update({ status: "submitting", worker_claim_token: token, worker_claimed_at: now, updated_at: now, error_code: null, error_detail: null })
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

async function renewOrderClaim(supabase: ServiceClient, table: JobTable, job: Row, token: string) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(table)
    .update({ worker_claimed_at: now, updated_at: now })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

async function markStale(
  supabase: ServiceClient,
  table: JobTable,
  job: Row,
  token: string,
  code: string,
  message: string,
) {
  await supabase
    .from(table)
    .update({ status: "stale", worker_claim_token: null, worker_claimed_at: null, updated_at: new Date().toISOString(), error_code: code, error_detail: message })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token);
}

async function releaseForSignerRetry(
  supabase: ServiceClient,
  table: JobTable,
  job: Row,
  token: string,
  error: RelayerSignerUnavailableError,
) {
  await supabase
    .from(table)
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

async function persistBroadcast(
  supabase: ServiceClient,
  table: JobTable,
  job: Row,
  token: string,
  txHash: Hex,
) {
  const { data, error } = await supabase
    .from(table)
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
  if (error) {
    throw new BroadcastPersistenceError(txHash, `Broadcast ${txHash} could not be persisted: ${error.message}`);
  }
  if (!data) {
    throw new WorkerClaimLostError(`${table} job ${job.id} claim was lost after broadcasting ${txHash}.`);
  }
}

async function observeBroadcastReceipt(
  supabase: ServiceClient,
  table: JobTable,
  jobId: string,
  txHash: Hex,
  publicClient: ReturnType<typeof createPublicClient>,
  label: string,
) {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== "success") {
      await supabase.from(table).update({
        status: "failed",
        chain_block_number: Number(receipt.blockNumber),
        updated_at: new Date().toISOString(),
        error_code: "CHAIN_TRANSACTION_REVERTED",
        error_detail: `${label} transaction reverted: ${txHash}`,
      }).eq("id", jobId).eq("status", "submitted").eq("chain_tx_hash", txHash);
      return;
    }

    await supabase.from(table).update({
      chain_block_number: Number(receipt.blockNumber),
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    }).eq("id", jobId).eq("status", "submitted").eq("chain_tx_hash", txHash);
  } catch (error) {
    await supabase.from(table).update({
      updated_at: new Date().toISOString(),
      error_code: "CHAIN_CONFIRMATION_PENDING",
      error_detail: errorDetail(error),
    }).eq("id", jobId).eq("status", "submitted").eq("chain_tx_hash", txHash);
  }
}

async function publicClientForRelayer() {
  const env = getOrderRelayerEnv();
  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) {
    throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);
  }
  return { env, publicClient, chainId };
}

async function relayAuthorization(supabase: ServiceClient, job: Row, lease: ClaimLease) {
  const token = String(job.worker_claim_token);
  const orderId = hex32(job.chain_order_id, "chain order id");
  const previousVersionHash = hex32(job.previous_version_hash, "previous version hash");
  const policyHash = hex32(job.policy_hash, "policy hash");
  if (!SIGNATURE.test(String(job.buyer_signature))) throw new Error("Buyer signature is missing or malformed");
  if (new Date(job.deadline).getTime() <= Date.now()) throw new StaleAuthorizationError("Authorization deadline expired");

  const [{ data: buyer, error: buyerError }, { data: factory, error: factoryError }] = await Promise.all([
    supabase.from("organizations").select("chain_organization_id,status").eq("id", job.buyer_organization_id).single(),
    supabase.from("organizations").select("chain_organization_id,status").eq("id", job.factory_organization_id).single(),
  ]);
  if (buyerError) throw buyerError;
  if (factoryError) throw factoryError;
  if (buyer.status !== "active" || factory.status !== "active") throw new StaleAuthorizationError("Buyer or factory is no longer active in the application mirror");

  const buyerOrganizationId = hex32(buyer.chain_organization_id, "buyer organization id");
  const factoryOrganizationId = hex32(factory.chain_organization_id, "factory organization id");
  const { env, publicClient, chainId } = await publicClientForRelayer();
  const orderRegistryAddress = env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`;
  const deadline = BigInt(Math.floor(new Date(job.deadline).getTime() / 1000));
  const authorization = {
    orderId,
    buyerOrganizationId,
    primaryFactoryOrganizationId: factoryOrganizationId,
    version: Number(job.target_version),
    previousVersionHash,
    orderCommitment: BigInt(job.order_commitment),
    policyHash,
    nonce: BigInt(job.nonce),
    deadline,
  } as const;
  const typedData = {
    domain: orderRegistryDomain(chainId, orderRegistryAddress),
    types: orderVersionTypes,
    primaryType: "OrderVersion" as const,
    message: authorization,
  };
  const signedTypedDataHash = hashTypedData(typedData);
  assertSignedDomainBinding(job, chainId, orderRegistryAddress, signedTypedDataHash, "Authorization");

  const signature = job.buyer_signature as Hex;
  const signer = await recoverTypedDataAddress({
    ...typedData,
    signature,
  });

  const [signerOrganization, signerActive, currentNonce] = await Promise.all([
    publicClient.readContract({
      address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`,
      abi: threadProofRegistryAbi,
      functionName: "organizationOfAccount",
      args: [signer],
    }),
    publicClient.readContract({
      address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`,
      abi: threadProofRegistryAbi,
      functionName: "isActiveAccount",
      args: [signer],
    }),
    publicClient.readContract({
      address: orderRegistryAddress,
      abi: orderRegistryAbi,
      functionName: "nonces",
      args: [buyerOrganizationId],
    }),
  ]);

  if (!signerActive || signerOrganization.toLowerCase() !== buyerOrganizationId.toLowerCase()) {
    throw new StaleAuthorizationError("Recovered wallet is not an active signer for the buyer organization");
  }
  if (currentNonce !== authorization.nonce) {
    throw new StaleAuthorizationError(`Buyer nonce advanced from ${authorization.nonce} to ${currentNonce}`);
  }

  if (authorization.version > 1) {
    const current = await publicClient.readContract({
      address: orderRegistryAddress,
      abi: orderRegistryAbi,
      functionName: "getOrder",
      args: [orderId],
    });
    if (
      current.status !== 1 ||
      current.buyerOrganizationId.toLowerCase() !== buyerOrganizationId.toLowerCase() ||
      current.currentVersion !== authorization.version - 1 ||
      current.currentVersionHash.toLowerCase() !== previousVersionHash.toLowerCase()
    ) {
      throw new StaleAuthorizationError("OrderRegistry state no longer matches the signed previous-version context");
    }
  } else if (previousVersionHash !== ZERO_HASH) {
    throw new StaleAuthorizationError("Version 1 authorization must use the zero previous-version hash");
  }

  await lease.renewNow();
  await persistValidatedSigner(supabase, "order_authorization_jobs", job, token, signer);
  await lease.renewNow();
  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request } = await publicClient.simulateContract({
    address: orderRegistryAddress,
    abi: orderRegistryAbi,
    functionName: "submitOrderVersion",
    args: [authorization, signature],
    account,
  });
  await lease.renewNow();
  const txHash = await wallet.writeContract(request);

  // The broadcast hash is the crash-recovery boundary. Persist it before waiting for a
  // receipt so a dead relayer never makes an already-sent transaction look unsent.
  lease.stop();
  await persistBroadcast(supabase, "order_authorization_jobs", job, token, txHash);
  await observeBroadcastReceipt(supabase, "order_authorization_jobs", job.id, txHash, publicClient, "OrderRegistry");
}

async function relayCancellation(supabase: ServiceClient, job: Row, lease: ClaimLease) {
  const token = String(job.worker_claim_token);
  const orderId = hex32(job.chain_order_id, "chain order id");
  if (!SIGNATURE.test(String(job.buyer_signature))) throw new Error("Buyer cancellation signature is missing or malformed");
  if (new Date(job.deadline).getTime() <= Date.now()) throw new StaleAuthorizationError("Cancellation deadline expired");

  const { data: buyer, error: buyerError } = await supabase
    .from("organizations")
    .select("chain_organization_id,status")
    .eq("id", job.buyer_organization_id)
    .single();
  if (buyerError) throw buyerError;
  if (buyer.status !== "active") throw new StaleAuthorizationError("Buyer is no longer active in the application mirror");

  const buyerOrganizationId = hex32(buyer.chain_organization_id, "buyer organization id");
  const { env, publicClient, chainId } = await publicClientForRelayer();
  const orderRegistryAddress = env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`;
  const authorization = {
    orderId,
    buyerOrganizationId,
    expectedVersion: Number(job.expected_version),
    nonce: BigInt(job.nonce),
    deadline: BigInt(Math.floor(new Date(job.deadline).getTime() / 1000)),
  } as const;
  const typedData = {
    domain: orderRegistryDomain(chainId, orderRegistryAddress),
    types: cancelOrderTypes,
    primaryType: "CancelOrder" as const,
    message: authorization,
  };
  const signedTypedDataHash = hashTypedData(typedData);
  assertSignedDomainBinding(job, chainId, orderRegistryAddress, signedTypedDataHash, "Cancellation");

  const signature = job.buyer_signature as Hex;
  const signer = await recoverTypedDataAddress({
    ...typedData,
    signature,
  });

  const [signerOrganization, signerActive, currentNonce, current] = await Promise.all([
    publicClient.readContract({
      address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`,
      abi: threadProofRegistryAbi,
      functionName: "organizationOfAccount",
      args: [signer],
    }),
    publicClient.readContract({
      address: env.THREADPROOF_REGISTRY_ADDRESS as `0x${string}`,
      abi: threadProofRegistryAbi,
      functionName: "isActiveAccount",
      args: [signer],
    }),
    publicClient.readContract({
      address: orderRegistryAddress,
      abi: orderRegistryAbi,
      functionName: "nonces",
      args: [buyerOrganizationId],
    }),
    publicClient.readContract({
      address: orderRegistryAddress,
      abi: orderRegistryAbi,
      functionName: "getOrder",
      args: [orderId],
    }),
  ]);

  if (!signerActive || signerOrganization.toLowerCase() !== buyerOrganizationId.toLowerCase()) {
    throw new StaleAuthorizationError("Recovered wallet is not an active signer for the buyer organization");
  }
  if (currentNonce !== authorization.nonce) {
    throw new StaleAuthorizationError(`Buyer nonce advanced from ${authorization.nonce} to ${currentNonce}`);
  }
  if (
    current.status !== 1 ||
    current.buyerOrganizationId.toLowerCase() !== buyerOrganizationId.toLowerCase() ||
    current.currentVersion !== authorization.expectedVersion
  ) {
    throw new StaleAuthorizationError("OrderRegistry state no longer matches the signed cancellation context");
  }

  await lease.renewNow();
  await persistValidatedSigner(supabase, "order_cancellation_jobs", job, token, signer);
  await lease.renewNow();
  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request } = await publicClient.simulateContract({
    address: orderRegistryAddress,
    abi: orderRegistryAbi,
    functionName: "cancelOrder",
    args: [authorization, signature],
    account,
  });
  await lease.renewNow();
  const txHash = await wallet.writeContract(request);

  lease.stop();
  await persistBroadcast(supabase, "order_cancellation_jobs", job, token, txHash);
  await observeBroadcastReceipt(supabase, "order_cancellation_jobs", job.id, txHash, publicClient, "OrderRegistry cancellation");
}

async function processAuthorizationJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const token = String(job.worker_claim_token);
  const lease = startClaimLease({
    heartbeatSeconds,
    label: `order authorization job ${job.id}`,
    renew: () => renewOrderClaim(supabase, "order_authorization_jobs", job, token),
  });
  try {
    await lease.renewNow();
    await relayAuthorization(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) {
      console.warn(`Stopped order authorization job ${job.id} after claim loss: ${error.message}`);
      return;
    }
    if (error instanceof BroadcastPersistenceError) {
      console.error(`Order authorization ${job.id} broadcast ${error.txHash} but persistence failed; canonical event indexing may still recover it: ${error.message}`);
      return;
    }
    if (error instanceof StaleAuthorizationError) {
      await markStale(supabase, "order_authorization_jobs", job, token, "ORDER_AUTH_STALE", error.message);
      return;
    }
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, "order_authorization_jobs", job, token, error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return;
    }

    const { data: latest } = await supabase
      .from("order_authorization_jobs")
      .select("status")
      .eq("id", job.id)
      .maybeSingle();
    if (latest?.status === "confirmed" || latest?.status === "submitted") return;

    await supabase
      .from("order_authorization_jobs")
      .update({
        status: "failed",
        worker_claim_token: null,
        worker_claimed_at: null,
        updated_at: new Date().toISOString(),
        error_code: "ORDER_RELAY_FAILED",
        error_detail: errorDetail(error),
      })
      .eq("id", job.id)
      .eq("status", "submitting")
      .eq("worker_claim_token", token);
  } finally {
    lease.stop();
  }
}

async function processCancellationJob(supabase: ServiceClient, job: Row, heartbeatSeconds: number) {
  const token = String(job.worker_claim_token);
  const lease = startClaimLease({
    heartbeatSeconds,
    label: `order cancellation job ${job.id}`,
    renew: () => renewOrderClaim(supabase, "order_cancellation_jobs", job, token),
  });
  try {
    await lease.renewNow();
    await relayCancellation(supabase, job, lease);
  } catch (error) {
    if (error instanceof WorkerClaimLostError) {
      console.warn(`Stopped order cancellation job ${job.id} after claim loss: ${error.message}`);
      return;
    }
    if (error instanceof BroadcastPersistenceError) {
      console.error(`Order cancellation ${job.id} broadcast ${error.txHash} but persistence failed; canonical event indexing may still recover it: ${error.message}`);
      return;
    }
    if (error instanceof StaleAuthorizationError) {
      await markStale(supabase, "order_cancellation_jobs", job, token, "ORDER_CANCEL_STALE", error.message);
      return;
    }
    if (error instanceof RelayerSignerUnavailableError) {
      await releaseForSignerRetry(supabase, "order_cancellation_jobs", job, token, error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return;
    }

    const { data: latest } = await supabase
      .from("order_cancellation_jobs")
      .select("status")
      .eq("id", job.id)
      .maybeSingle();
    if (latest?.status === "confirmed" || latest?.status === "submitted") return;

    await supabase
      .from("order_cancellation_jobs")
      .update({
        status: "failed",
        worker_claim_token: null,
        worker_claimed_at: null,
        updated_at: new Date().toISOString(),
        error_code: "ORDER_CANCEL_RELAY_FAILED",
        error_detail: errorDetail(error),
      })
      .eq("id", job.id)
      .eq("status", "submitting")
      .eq("worker_claim_token", token);
  } finally {
    lease.stop();
  }
}

async function main() {
  const env = getOrderRelayerEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`ThreadProof order relayer started with ${env.THREADPROOF_SIGNER_MODE} signing`);
  while (true) {
    await releaseAbandonedClaims(supabase, env.THREADPROOF_WORKER_LEASE_SECONDS);

    const cancellationJob = await claimSignedCancellationJob(supabase);
    if (cancellationJob) {
      await processCancellationJob(supabase, cancellationJob, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
      continue;
    }

    const authorizationJob = await claimSignedAuthorizationJob(supabase);
    if (authorizationJob) {
      await processAuthorizationJob(supabase, authorizationJob, env.THREADPROOF_WORKER_HEARTBEAT_SECONDS);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});