"use server";

import { revalidatePath } from "next/cache";
import { recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import {
  getOrderNetwork,
  organizationRegistryReadAbi,
  orderRegistryReadAbi,
  requireHex32,
} from "@/lib/order-authorization.server";
import {
  buildCancelOrderTypedData,
  type PreparedOrderCancellation,
} from "@/lib/order-eip712";

const prepareSchema = z.object({ orderId: z.string().uuid() });
const signatureSchema = z.object({
  jobId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export type CancellationActionResult =
  | { ok: true; cancellation: PreparedOrderCancellation }
  | { ok: false; error: string };

export type CancellationSignatureResult =
  | { ok: true; signer: string }
  | { ok: false; error: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected cancellation error.";
}

function cancellationFromJob(
  job: {
    id: string;
    chain_order_id: string;
    expected_version: number;
    nonce: string;
    deadline: string;
  },
  chainId: number,
  orderRegistryAddress: `0x${string}`,
  buyerOrganizationId: Hex,
): PreparedOrderCancellation {
  return {
    jobId: job.id,
    orderId: requireHex32(job.chain_order_id, "Order ID"),
    chainId,
    orderRegistryAddress,
    buyerOrganizationId,
    expectedVersion: job.expected_version,
    nonce: job.nonce,
    deadline: Math.floor(new Date(job.deadline).getTime() / 1000).toString(),
  };
}

export async function prepareOrderCancellationAction(input: unknown): Promise<CancellationActionResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = prepareSchema.parse(input);
    const supabase = await createClient();

    const { data: order, error: orderError } = await supabase
      .from("purchase_orders")
      .select("*")
      .eq("id", parsed.orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return { ok: false, error: "Order not found." };
    if (order.current_version <= 0) return { ok: false, error: "Only an anchored OrderRegistry order can be cancelled." };
    if (!["proposed", "feasible", "infeasible", "accepted"].includes(order.status)) {
      return { ok: false, error: "This order is not in a cancellable state." };
    }

    const membership = viewer.memberships.find((item) => item.organization_id === order.buyer_organization_id);
    if (
      !membership ||
      !hasOperationalRole(membership) ||
      membership.organization.role !== "buyer" ||
      membership.organization.status !== "active"
    ) {
      return { ok: false, error: "Active buyer operator or signer membership is required." };
    }

    const buyerOrganizationId = requireHex32(membership.organization.chain_organization_id, "Buyer organization ID");
    const chainOrderId = requireHex32(order.chain_order_id, "Order ID");
    const network = getOrderNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) {
      return { ok: false, error: `Besu chain ID ${actualChainId} does not match configured chain ID ${network.configuredChainId}.` };
    }

    const [{ data: currentVersion, error: versionError }, chainState, nonce] = await Promise.all([
      supabase
        .from("order_versions")
        .select("version,version_hash,order_commitment,policy_hash")
        .eq("purchase_order_id", order.id)
        .eq("version", order.current_version)
        .maybeSingle(),
      network.client.readContract({
        address: network.orderRegistryAddress,
        abi: orderRegistryReadAbi,
        functionName: "getOrder",
        args: [chainOrderId],
      }),
      network.client.readContract({
        address: network.orderRegistryAddress,
        abi: orderRegistryReadAbi,
        functionName: "nonces",
        args: [buyerOrganizationId],
      }),
    ]);
    if (versionError) throw versionError;
    if (!currentVersion?.version_hash) {
      return { ok: false, error: "Current order version is not fully indexed from OrderRegistry." };
    }

    if (
      chainState.status !== 1 ||
      chainState.buyerOrganizationId.toLowerCase() !== buyerOrganizationId.toLowerCase() ||
      chainState.currentVersion !== order.current_version ||
      chainState.currentVersionHash.toLowerCase() !== currentVersion.version_hash.toLowerCase() ||
      chainState.currentOrderCommitment !== BigInt(currentVersion.order_commitment) ||
      chainState.currentPolicyHash.toLowerCase() !== currentVersion.policy_hash.toLowerCase()
    ) {
      return { ok: false, error: "Application order mirror is stale relative to OrderRegistry. Cancellation is blocked until it reconciles." };
    }

    const { data: activeAuthorization, error: authorizationError } = await supabase
      .from("order_authorization_jobs")
      .select("id,status")
      .eq("purchase_order_id", order.id)
      .in("status", ["prepared", "signed", "submitting", "submitted"])
      .limit(1)
      .maybeSingle();
    if (authorizationError) throw authorizationError;
    if (activeAuthorization) {
      return { ok: false, error: "An order version authorization is already in progress. Let it finish or discard the unsigned preparation before cancelling." };
    }

    const { data: activeCancellations, error: cancellationsError } = await supabase
      .from("order_cancellation_jobs")
      .select("id,status,created_by")
      .eq("purchase_order_id", order.id)
      .in("status", ["prepared", "signed", "submitting", "submitted"])
      .order("created_at", { ascending: false });
    if (cancellationsError) throw cancellationsError;

    const inFlight = (activeCancellations ?? []).find((job) => job.status !== "prepared" || job.created_by !== viewer.userId);
    if (inFlight) return { ok: false, error: "An order cancellation is already in progress." };
    for (const prepared of activeCancellations ?? []) {
      const { error: deleteError } = await supabase.from("order_cancellation_jobs").delete().eq("id", prepared.id);
      if (deleteError) throw deleteError;
    }

    const deadlineSeconds = Math.floor(Date.now() / 1000) + 15 * 60;
    const deadlineIso = new Date(deadlineSeconds * 1000).toISOString();
    const { data: job, error: insertError } = await supabase
      .from("order_cancellation_jobs")
      .insert({
        purchase_order_id: order.id,
        chain_order_id: chainOrderId,
        buyer_organization_id: order.buyer_organization_id,
        expected_version: order.current_version,
        nonce: nonce.toString(),
        deadline: deadlineIso,
        created_by: viewer.userId,
        status: "prepared",
      })
      .select("id,chain_order_id,expected_version,nonce,deadline")
      .single();
    if (insertError) throw insertError;

    return {
      ok: true,
      cancellation: cancellationFromJob(job, actualChainId, network.orderRegistryAddress, buyerOrganizationId),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function submitOrderCancellationSignatureAction(input: unknown): Promise<CancellationSignatureResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = signatureSchema.parse(input);
    const supabase = await createClient();
    const { data: job, error: jobError } = await supabase
      .from("order_cancellation_jobs")
      .select("*")
      .eq("id", parsed.jobId)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.status !== "prepared") return { ok: false, error: "Prepared cancellation is no longer available." };
    if (new Date(job.deadline).getTime() <= Date.now()) return { ok: false, error: "The cancellation deadline expired. Prepare a fresh cancellation." };

    const membership = viewer.memberships.find((item) => item.organization_id === job.buyer_organization_id);
    if (
      !membership ||
      !hasOperationalRole(membership) ||
      membership.organization.role !== "buyer" ||
      membership.organization.status !== "active"
    ) {
      return { ok: false, error: "Active buyer operator or signer membership is required." };
    }

    const buyerOrganizationId = requireHex32(membership.organization.chain_organization_id, "Buyer organization ID");
    const network = getOrderNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) {
      return { ok: false, error: "Configured Besu chain is unavailable or has the wrong chain ID." };
    }

    const cancellation = cancellationFromJob(job, actualChainId, network.orderRegistryAddress, buyerOrganizationId);
    const signer = await recoverTypedDataAddress({
      ...buildCancelOrderTypedData(cancellation),
      signature: parsed.signature as Hex,
    });

    const [signerOrganizationId, signerActive, currentNonce, chainState] = await Promise.all([
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
        args: [buyerOrganizationId],
      }),
      network.client.readContract({
        address: network.orderRegistryAddress,
        abi: orderRegistryReadAbi,
        functionName: "getOrder",
        args: [cancellation.orderId],
      }),
    ]);

    if (!signerActive || signerOrganizationId.toLowerCase() !== buyerOrganizationId.toLowerCase()) {
      return { ok: false, error: "The connected wallet is not an active signer for this buyer organization." };
    }
    if (currentNonce.toString() !== job.nonce) {
      return { ok: false, error: "The buyer nonce changed before the cancellation signature was stored. Prepare a fresh cancellation." };
    }
    if (
      chainState.status !== 1 ||
      chainState.buyerOrganizationId.toLowerCase() !== buyerOrganizationId.toLowerCase() ||
      chainState.currentVersion !== job.expected_version
    ) {
      return { ok: false, error: "OrderRegistry state changed before the cancellation signature was stored." };
    }

    const { data: updated, error: updateError } = await supabase
      .from("order_cancellation_jobs")
      .update({ buyer_signature: parsed.signature, status: "signed", updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "prepared")
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return { ok: false, error: "Cancellation changed before the signature could be stored." };

    revalidatePath(`/app/orders/${job.purchase_order_id}`);
    revalidatePath("/app/orders");
    return { ok: true, signer };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
