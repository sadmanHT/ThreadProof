import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  http,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { orderRegistryAbi, threadProofRegistryAbi } from "./chain.js";
import { getOrderRelayerEnv } from "./env.js";
import { createRelayerWallet, RelayerSignerUnavailableError } from "./signer.js";
import { createServiceClient } from "./supabase.js";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
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

async function releaseAbandonedClaims(supabase: ServiceClient) {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const now = new Date().toISOString();

  await supabase
    .from("order_authorization_jobs")
    .update({ status: "signed", worker_claim_token: null, worker_claimed_at: null, updated_at: now })
    .eq("status", "submitting")
    .is("chain_tx_hash", null)
    .lt("worker_claimed_at", cutoff);
  await supabase
    .from("order_cancellation_jobs")
    .update({ status: "signed", worker_claim_token: null, worker_claimed_at: null, updated_at: now })
    .eq("status", "submitting")
    .is("chain_tx_hash", null)
    .lt("worker_claimed_at", cutoff);

  await supabase
    .from("order_authorization_jobs")
    .update({ status: "stale", worker_claim_token: null, worker_claimed_at: null, updated_at: now, error_code: "DEADLINE_EXPIRED", error_detail: "Buyer authorization deadline expired before relay." })
    .in("status", ["prepared", "signed"])
    .lt("deadline", now);
  await supabase
    .from("order_cancellation_jobs")
    .update({ status: "stale", worker_claim_token: null, worker_claimed_at: null, updated_at: now, error_code: "DEADLINE_EXPIRED", error_detail: "Buyer cancellation deadline expired before relay." })
    .in("status", ["prepared", "signed"])
    .lt("deadline", now);
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

async function publicClientForRelayer() {
  const env = getOrderRelayerEnv();
  const publicClient = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const chainId = await publicClient.getChainId();
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) {
    throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);
  }
  return { env, publicClient, chainId };
}

async function relayAuthorization(supabase: ServiceClient, job: Row) {
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

  const signature = job.buyer_signature as Hex;
  const signer = await recoverTypedDataAddress({
    domain: orderRegistryDomain(chainId, env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`),
    types: orderVersionTypes,
    primaryType: "OrderVersion",
    message: authorization,
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
      address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
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
      address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
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

  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request } = await publicClient.simulateContract({
    address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
    abi: orderRegistryAbi,
    functionName: "submitOrderVersion",
    args: [authorization, signature],
    account,
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`OrderRegistry transaction ${txHash} reverted`);

  await supabase
    .from("order_authorization_jobs")
    .update({
      status: "submitted",
      chain_tx_hash: txHash,
      chain_block_number: Number(receipt.blockNumber),
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token);
}

async function relayCancellation(supabase: ServiceClient, job: Row) {
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
  const authorization = {
    orderId,
    buyerOrganizationId,
    expectedVersion: Number(job.expected_version),
    nonce: BigInt(job.nonce),
    deadline: BigInt(Math.floor(new Date(job.deadline).getTime() / 1000)),
  } as const;
  const signature = job.buyer_signature as Hex;
  const signer = await recoverTypedDataAddress({
    domain: orderRegistryDomain(chainId, env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`),
    types: cancelOrderTypes,
    primaryType: "CancelOrder",
    message: authorization,
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
      address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
      abi: orderRegistryAbi,
      functionName: "nonces",
      args: [buyerOrganizationId],
    }),
    publicClient.readContract({
      address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
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

  const { account, wallet } = await createRelayerWallet(env, chainId);
  const { request } = await publicClient.simulateContract({
    address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as `0x${string}`,
    abi: orderRegistryAbi,
    functionName: "cancelOrder",
    args: [authorization, signature],
    account,
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`OrderRegistry cancellation ${txHash} reverted`);

  await supabase
    .from("order_cancellation_jobs")
    .update({
      status: "submitted",
      chain_tx_hash: txHash,
      chain_block_number: Number(receipt.blockNumber),
      worker_claim_token: null,
      worker_claimed_at: null,
      updated_at: new Date().toISOString(),
      error_code: null,
      error_detail: null,
    })
    .eq("id", job.id)
    .eq("status", "submitting")
    .eq("worker_claim_token", token);
}

async function processAuthorizationJob(supabase: ServiceClient, job: Row) {
  const token = String(job.worker_claim_token);
  try {
    await relayAuthorization(supabase, job);
  } catch (error) {
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
    if (latest?.status === "confirmed") return;

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
  }
}

async function processCancellationJob(supabase: ServiceClient, job: Row) {
  const token = String(job.worker_claim_token);
  try {
    await relayCancellation(supabase, job);
  } catch (error) {
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
    if (latest?.status === "confirmed") return;

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
  }
}

async function main() {
  const env = getOrderRelayerEnv();
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`ThreadProof order relayer started with ${env.THREADPROOF_SIGNER_MODE} signing`);
  while (true) {
    await releaseAbandonedClaims(supabase);

    const cancellationJob = await claimSignedCancellationJob(supabase);
    if (cancellationJob) {
      await processCancellationJob(supabase, cancellationJob);
      continue;
    }

    const authorizationJob = await claimSignedAuthorizationJob(supabase);
    if (authorizationJob) {
      await processAuthorizationJob(supabase, authorizationJob);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
