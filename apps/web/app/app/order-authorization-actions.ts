"use server";

import { revalidatePath } from "next/cache";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import {
  computeOrderCommitment,
  encryptOrderPayload,
  getOrderNetwork,
  organizationRegistryReadAbi,
  orderRegistryReadAbi,
  randomFieldElement,
  requireHex32,
  UINT64_MAX,
  ZERO_HASH,
} from "@/lib/order-authorization.server";
import {
  buildOrderTypedData,
  type PreparedOrderAuthorization,
} from "@/lib/order-eip712";

const prepareSchema = z.object({
  orderId: z.string().uuid(),
  orderWorkload: z.string().regex(/^[0-9]+$/),
  policyHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  productionPeriodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  productionPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});

const signatureSchema = z.object({
  jobId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export type AuthorizationActionResult =
  | { ok: true; authorization: PreparedOrderAuthorization }
  | { ok: false; error: string };

export type SignatureActionResult =
  | { ok: true; signer: string }
  | { ok: false; error: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected authorization error.";
}

function authorizationFromJob(
  job: {
    id: string;
    purchase_order_id: string;
    chain_order_id: string;
    buyer_organization_id: string;
    factory_organization_id: string;
    target_version: number;
    previous_version_hash: string;
    order_commitment: string;
    policy_hash: string;
    nonce: string;
    deadline: string;
  },
  chainId: number,
  orderRegistryAddress: `0x${string}`,
  buyerChainId: Hex,
  factoryChainId: Hex,
): PreparedOrderAuthorization {
  return {
    jobId: job.id,
    orderId: job.chain_order_id,
    chainId,
    orderRegistryAddress,
    buyerOrganizationId: buyerChainId,
    factoryOrganizationId: factoryChainId,
    version: job.target_version,
    previousVersionHash: job.previous_version_hash as Hex,
    orderCommitment: job.order_commitment,
    policyHash: job.policy_hash as Hex,
    nonce: job.nonce,
    deadline: Math.floor(new Date(job.deadline).getTime() / 1000).toString(),
  };
}

export async function prepareOrderAuthorizationAction(input: unknown): Promise<AuthorizationActionResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = prepareSchema.parse(input);
    const workload = BigInt(parsed.orderWorkload);
    if (workload <= 0n || workload > UINT64_MAX) {
      return { ok: false, error: "Confidential workload must be between 1 and 2^64-1." };
    }
    if (parsed.productionPeriodStart && parsed.productionPeriodEnd && parsed.productionPeriodEnd < parsed.productionPeriodStart) {
      return { ok: false, error: "Production period end must not be before the start date." };
    }

    const supabase = await createClient();
    const { data: order, error: orderError } = await supabase
      .from("purchase_orders")
      .select("*")
      .eq("id", parsed.orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return { ok: false, error: "Order not found." };
    if (!order.factory_organization_id) return { ok: false, error: "A factory counterparty is required." };
    if (!["draft", "proposed", "feasible", "infeasible"].includes(order.status)) {
      return { ok: false, error: "This order is not in an authorizable state." };
    }

    const membership = viewer.memberships.find((item) => item.organization_id === order.buyer_organization_id);
    if (!membership || !hasOperationalRole(membership) || membership.organization.role !== "buyer" || membership.organization.status !== "active") {
      return { ok: false, error: "Active buyer operator or signer membership is required." };
    }

    const { data: factory, error: factoryError } = await supabase
      .from("organizations")
      .select("id,role,status,chain_organization_id")
      .eq("id", order.factory_organization_id)
      .maybeSingle();
    if (factoryError) throw factoryError;
    if (!factory || factory.role !== "factory" || factory.status !== "active") {
      return { ok: false, error: "The factory counterparty is not active." };
    }

    const buyerChainId = requireHex32(membership.organization.chain_organization_id, "Buyer organization ID");
    const factoryChainId = requireHex32(factory.chain_organization_id, "Factory organization ID");
    const chainOrderId = requireHex32(order.chain_order_id, "Order ID");
    const policyHash = requireHex32(parsed.policyHash.toLowerCase(), "Policy hash");
    const targetVersion = order.current_version + 1;
    let previousVersionHash = ZERO_HASH;

    const network = getOrderNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) {
      return { ok: false, error: `Besu chain ID ${actualChainId} does not match configured chain ID ${network.configuredChainId}.` };
    }

    if (order.current_version > 0) {
      const { data: currentVersion, error: versionError } = await supabase
        .from("order_versions")
        .select("version,version_hash,order_commitment,policy_hash")
        .eq("purchase_order_id", order.id)
        .eq("version", order.current_version)
        .maybeSingle();
      if (versionError) throw versionError;
      if (!currentVersion?.version_hash) {
        return { ok: false, error: "Current order version is not fully indexed from OrderRegistry." };
      }
      previousVersionHash = requireHex32(currentVersion.version_hash, "Previous version hash");

      const chainState = await network.client.readContract({
        address: network.orderRegistryAddress,
        abi: orderRegistryReadAbi,
        functionName: "getOrder",
        args: [chainOrderId],
      });
      if (
        chainState.buyerOrganizationId.toLowerCase() !== buyerChainId.toLowerCase() ||
        chainState.currentVersion !== order.current_version ||
        chainState.currentVersionHash.toLowerCase() !== previousVersionHash.toLowerCase() ||
        BigInt(currentVersion.order_commitment) !== chainState.currentOrderCommitment ||
        currentVersion.policy_hash.toLowerCase() !== chainState.currentPolicyHash.toLowerCase() ||
        chainState.status !== 1
      ) {
        return { ok: false, error: "Application order mirror is stale relative to OrderRegistry. Authorization is blocked until it reconciles." };
      }
    }

    const nonce = await network.client.readContract({
      address: network.orderRegistryAddress,
      abi: orderRegistryReadAbi,
      functionName: "nonces",
      args: [buyerChainId],
    });

    const { data: activeJobs, error: activeJobsError } = await supabase
      .from("order_authorization_jobs")
      .select("id,status,created_by")
      .eq("purchase_order_id", order.id)
      .eq("target_version", targetVersion)
      .in("status", ["prepared", "signed", "submitting", "submitted"]);
    if (activeJobsError) throw activeJobsError;

    const inFlight = (activeJobs ?? []).find((job) => job.status !== "prepared" || job.created_by !== viewer.userId);
    if (inFlight) {
      return { ok: false, error: `Version ${targetVersion} already has an authorization in progress.` };
    }
    for (const prepared of activeJobs ?? []) {
      const { error: deleteError } = await supabase.from("order_authorization_jobs").delete().eq("id", prepared.id);
      if (deleteError) throw deleteError;
    }

    const orderRandomness = randomFieldElement();
    const orderCommitment = await computeOrderCommitment(chainOrderId, workload, orderRandomness);
    const encrypted = encryptOrderPayload({
      orderWorkload: workload.toString(),
      orderRandomness: orderRandomness.toString(),
    });
    const deadlineSeconds = Math.floor(Date.now() / 1000) + 15 * 60;
    const deadlineIso = new Date(deadlineSeconds * 1000).toISOString();
    const preparedForDigest: PreparedOrderAuthorization = {
      jobId: "pending",
      orderId: chainOrderId,
      chainId: actualChainId,
      orderRegistryAddress: network.orderRegistryAddress,
      buyerOrganizationId: buyerChainId,
      factoryOrganizationId: factoryChainId,
      version: targetVersion,
      previousVersionHash,
      orderCommitment: orderCommitment.toString(),
      policyHash,
      nonce: nonce.toString(),
      deadline: deadlineSeconds.toString(),
    };
    const signedTypedDataHash = hashTypedData(buildOrderTypedData(preparedForDigest));

    const { data: job, error: insertError } = await supabase
      .from("order_authorization_jobs")
      .insert({
        purchase_order_id: order.id,
        target_version: targetVersion,
        chain_order_id: chainOrderId,
        buyer_organization_id: order.buyer_organization_id,
        factory_organization_id: order.factory_organization_id,
        previous_version_hash: previousVersionHash,
        order_commitment: orderCommitment.toString(),
        policy_hash: policyHash,
        nonce: nonce.toString(),
        deadline: deadlineIso,
        confidential_payload_ciphertext: encrypted.ciphertext,
        payload_nonce: encrypted.nonce,
        production_period_start: parsed.productionPeriodStart || null,
        production_period_end: parsed.productionPeriodEnd || null,
        signed_chain_id: actualChainId,
        signed_order_registry_address: network.orderRegistryAddress,
        signed_typed_data_hash: signedTypedDataHash,
        created_by: viewer.userId,
        status: "prepared",
      })
      .select("id,purchase_order_id,chain_order_id,buyer_organization_id,factory_organization_id,target_version,previous_version_hash,order_commitment,policy_hash,nonce,deadline")
      .single();
    if (insertError) throw insertError;

    return {
      ok: true,
      authorization: authorizationFromJob(
        job,
        actualChainId,
        network.orderRegistryAddress,
        buyerChainId,
        factoryChainId,
      ),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function submitOrderSignatureAction(input: unknown): Promise<SignatureActionResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = signatureSchema.parse(input);
    const supabase = await createClient();
    const { data: job, error: jobError } = await supabase
      .from("order_authorization_jobs")
      .select("*")
      .eq("id", parsed.jobId)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.status !== "prepared") return { ok: false, error: "Prepared authorization is no longer available." };
    if (new Date(job.deadline).getTime() <= Date.now()) return { ok: false, error: "The authorization deadline expired. Prepare a new authorization." };

    const membership = viewer.memberships.find((item) => item.organization_id === job.buyer_organization_id);
    if (!membership || !hasOperationalRole(membership)) {
      return { ok: false, error: "Buyer operator or signer membership is required." };
    }
    const { data: factory, error: factoryError } = await supabase
      .from("organizations")
      .select("chain_organization_id")
      .eq("id", job.factory_organization_id)
      .maybeSingle();
    if (factoryError) throw factoryError;
    if (!factory) return { ok: false, error: "Factory organization is unavailable." };

    const buyerChainId = requireHex32(membership.organization.chain_organization_id, "Buyer organization ID");
    const factoryChainId = requireHex32(factory.chain_organization_id, "Factory organization ID");
    const network = getOrderNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) return { ok: false, error: "Configured Besu chain is unavailable or has the wrong chain ID." };
    if (
      Number(job.signed_chain_id) !== actualChainId ||
      String(job.signed_order_registry_address ?? "").toLowerCase() !== network.orderRegistryAddress.toLowerCase()
    ) {
      return { ok: false, error: "Prepared authorization is bound to a different OrderRegistry domain. Prepare a fresh authorization." };
    }

    const authorization = authorizationFromJob(job, actualChainId, network.orderRegistryAddress, buyerChainId, factoryChainId);
    const typedData = buildOrderTypedData(authorization);
    const signedTypedDataHash = hashTypedData(typedData);
    if (String(job.signed_typed_data_hash ?? "").toLowerCase() !== signedTypedDataHash.toLowerCase()) {
      return { ok: false, error: "Prepared authorization digest no longer matches its signed payload. Prepare a fresh authorization." };
    }
    const signer = await recoverTypedDataAddress({ ...typedData, signature: parsed.signature as Hex });
    const [signerOrganizationId, signerActive, currentNonce] = await Promise.all([
      network.client.readContract({
        address: network.organizationRegistryAddress,
        abi: organizationRegistryReadAbi,
        functionName: "organizationOfAccount",
        args: [signer],
      }),
      network.client.readContract({
        address: network.organizationRegistryAddress,
        abi: organizationRegistryReadAbi,
        functionName: "isActiveAccount",
        args: [signer],
      }),
      network.client.readContract({
        address: network.orderRegistryAddress,
        abi: orderRegistryReadAbi,
        functionName: "nonces",
        args: [buyerChainId],
      }),
    ]);

    if (!signerActive || signerOrganizationId.toLowerCase() !== buyerChainId.toLowerCase()) {
      return { ok: false, error: "The connected wallet is not an active signer for this buyer organization." };
    }
    if (currentNonce.toString() !== job.nonce) {
      return { ok: false, error: "The buyer nonce changed before the signature was stored. Prepare a fresh authorization." };
    }

    const { data: updated, error: updateError } = await supabase
      .from("order_authorization_jobs")
      .update({ buyer_signature: parsed.signature, status: "signed", updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "prepared")
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return { ok: false, error: "Authorization changed before the signature could be stored." };

    revalidatePath(`/app/orders/${job.purchase_order_id}`);
    revalidatePath("/app/orders");
    return { ok: true, signer };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
