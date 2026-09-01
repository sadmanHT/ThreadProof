"use server";

import { revalidatePath } from "next/cache";
import { recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service.server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { requireHex32 } from "@/lib/order-authorization.server";
import {
  authorizationFromSubcontractJob,
  getSubcontractNetwork,
  nextSubcontractSequence,
  subcontractCapacityVaultAbi,
  subcontractCredentialRegistryAbi,
  subcontractGovernorReadAbi,
  subcontractOrderRegistryAbi,
  subcontractOrganizationRegistryAbi,
} from "@/lib/subcontract-authorization.server";
import {
  buildSubcontractTypedData,
  subcontractAuthorizationMessage,
  type PreparedSubcontractAuthorization,
} from "@/lib/subcontract-eip712";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const prepareSchema = z.object({
  parentOrderId: z.string().uuid(),
  childOrderChainId: hex32,
  capacityAllocationChainId: hex32,
  complianceCredentialChainId: hex32,
  processCredentialChainId: hex32,
});
const signatureSchema = z.object({
  jobId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export type SubcontractPrepareResult =
  | { ok: true; authorization: PreparedSubcontractAuthorization }
  | { ok: false; error: string };
export type SubcontractSignatureResult =
  | { ok: true; signer: string }
  | { ok: false; error: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected subcontract authorization error.";
}

function sameHex(left: string | null | undefined, right: string) {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function chainOrderMirrorMatches(
  mirror: {
    buyer_organization_id: string;
    factory_organization_id: string | null;
    current_version: number;
    current_order_commitment: string | null;
    current_policy_hash: string | null;
  },
  versionHash: string,
  buyerChainId: Hex,
  factoryChainId: Hex,
  chain: {
    buyerOrganizationId: Hex;
    primaryFactoryOrganizationId: Hex;
    currentVersion: number;
    currentVersionHash: Hex;
    currentOrderCommitment: bigint;
    currentPolicyHash: Hex;
    status: number;
  },
) {
  return chain.status === 1
    && chain.currentVersion === mirror.current_version
    && sameHex(chain.currentVersionHash, versionHash)
    && sameHex(chain.buyerOrganizationId, buyerChainId)
    && sameHex(chain.primaryFactoryOrganizationId, factoryChainId)
    && mirror.current_order_commitment !== null
    && BigInt(mirror.current_order_commitment) === chain.currentOrderCommitment
    && mirror.current_policy_hash !== null
    && sameHex(mirror.current_policy_hash, chain.currentPolicyHash);
}

export async function prepareSubcontractAuthorizationAction(input: unknown): Promise<SubcontractPrepareResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = prepareSchema.parse(input);
    const supabase = await createClient();
    const service = createServiceClient();

    const { data: parent, error: parentError } = await supabase
      .from("purchase_orders")
      .select("*")
      .eq("id", parsed.parentOrderId)
      .maybeSingle();
    if (parentError) throw parentError;
    if (!parent || !parent.factory_organization_id || parent.current_version <= 0) {
      return { ok: false, error: "A current parent order assigned to your factory is required." };
    }
    if (!["proposed", "feasible", "infeasible", "accepted"].includes(parent.status)) {
      return { ok: false, error: "The parent order is not currently production-authorized." };
    }

    const membership = viewer.memberships.find((item) => item.organization_id === parent.factory_organization_id);
    if (!membership || !hasOperationalRole(membership) || membership.organization.role !== "factory" || membership.organization.status !== "active") {
      return { ok: false, error: "An active parent-factory operator or signer membership is required." };
    }

    const childChainOrderId = requireHex32(parsed.childOrderChainId.toLowerCase(), "Child order ID");
    const chainAllocationId = requireHex32(parsed.capacityAllocationChainId.toLowerCase(), "Capacity allocation ID");
    const chainComplianceCredentialId = requireHex32(parsed.complianceCredentialChainId.toLowerCase(), "Compliance credential ID");
    const chainProcessCredentialId = requireHex32(parsed.processCredentialChainId.toLowerCase(), "Process credential ID");

    const [childResult, parentVersionResult, allocationResult, complianceResult, processResult] = await Promise.all([
      service.from("purchase_orders").select("*").eq("chain_order_id", childChainOrderId).maybeSingle(),
      service.from("order_versions").select("*").eq("purchase_order_id", parent.id).eq("version", parent.current_version).maybeSingle(),
      service.from("capacity_allocations").select("*").eq("chain_allocation_id", chainAllocationId).maybeSingle(),
      service.from("credentials").select("*").eq("chain_credential_id", chainComplianceCredentialId).maybeSingle(),
      service.from("credentials").select("*").eq("chain_credential_id", chainProcessCredentialId).maybeSingle(),
    ]);
    for (const result of [childResult, parentVersionResult, allocationResult, complianceResult, processResult]) {
      if (result.error) throw result.error;
    }
    const child = childResult.data;
    const parentVersion = parentVersionResult.data;
    const allocation = allocationResult.data;
    const complianceCredential = complianceResult.data;
    const processCredential = processResult.data;

    if (!child || !child.factory_organization_id || child.current_version <= 0 || !parentVersion?.version_hash) {
      return { ok: false, error: "The referenced child order or current parent version is not fully indexed." };
    }
    if (child.id === parent.id || child.chain_order_id.toLowerCase() === parent.chain_order_id.toLowerCase()) {
      return { ok: false, error: "Parent and child orders must be different." };
    }
    if (child.buyer_organization_id !== parent.buyer_organization_id) {
      return { ok: false, error: "Parent and child orders must have the same buyer." };
    }
    if (child.factory_organization_id === parent.factory_organization_id) {
      return { ok: false, error: "The child order must be assigned to a different factory." };
    }
    if (!["proposed", "feasible", "infeasible", "accepted"].includes(child.status)) {
      return { ok: false, error: "The child order is not currently production-authorized." };
    }
    if (!parent.current_policy_hash || !child.current_policy_hash || parent.current_policy_hash.toLowerCase() !== child.current_policy_hash.toLowerCase()) {
      return { ok: false, error: "Parent and child orders do not share the same current policy." };
    }

    const [childVersionResult, parentFactoryResult, subcontractorResult, buyerResult] = await Promise.all([
      service.from("order_versions").select("*").eq("purchase_order_id", child.id).eq("version", child.current_version).maybeSingle(),
      service.from("organizations").select("*").eq("id", parent.factory_organization_id).maybeSingle(),
      service.from("organizations").select("*").eq("id", child.factory_organization_id).maybeSingle(),
      service.from("organizations").select("*").eq("id", parent.buyer_organization_id).maybeSingle(),
    ]);
    for (const result of [childVersionResult, parentFactoryResult, subcontractorResult, buyerResult]) {
      if (result.error) throw result.error;
    }
    const childVersion = childVersionResult.data;
    const parentFactory = parentFactoryResult.data;
    const subcontractor = subcontractorResult.data;
    const buyer = buyerResult.data;
    if (!childVersion?.version_hash || !parentFactory || !subcontractor || !buyer) {
      return { ok: false, error: "Current order counterparties or child version are not fully indexed." };
    }
    if (parentFactory.role !== "factory" || parentFactory.status !== "active" || subcontractor.role !== "factory" || subcontractor.status !== "active") {
      return { ok: false, error: "Both parent and subcontract factories must currently be active factories." };
    }
    if (!allocation || !allocation.chain_allocation_id || !allocation.confirmed_at) {
      return { ok: false, error: "The child requires a confirmed canonical capacity allocation." };
    }
    if (!complianceCredential || !processCredential) {
      return { ok: false, error: "Both subcontract credentials must already be indexed." };
    }
    if (complianceCredential.subject_organization_id !== child.factory_organization_id || processCredential.subject_organization_id !== child.factory_organization_id) {
      return { ok: false, error: "Both credentials must be issued to the subcontractor factory." };
    }
    const now = Date.now();
    for (const credential of [complianceCredential, processCredential]) {
      if (credential.status !== "active" || new Date(credential.valid_from).getTime() > now || new Date(credential.valid_until).getTime() < now) {
        return { ok: false, error: "A selected subcontract credential is not currently active." };
      }
    }

    const [allocationVersionResult, openingResult] = await Promise.all([
      service.from("order_versions").select("*").eq("id", allocation.order_version_id).maybeSingle(),
      service.from("private_capacity_openings").select("id,factory_organization_id,chain_period_id,chain_process_id,policy_hash").eq("id", allocation.capacity_opening_id).maybeSingle(),
    ]);
    if (allocationVersionResult.error) throw allocationVersionResult.error;
    if (openingResult.error) throw openingResult.error;
    const allocationVersion = allocationVersionResult.data;
    const opening = openingResult.data;
    if (!allocationVersion || allocationVersion.purchase_order_id !== child.id || allocationVersion.version !== child.current_version) {
      return { ok: false, error: "The capacity allocation is not bound to the child order's current version." };
    }
    if (!opening?.chain_period_id || !opening.chain_process_id || opening.factory_organization_id !== child.factory_organization_id) {
      return { ok: false, error: "The capacity allocation is missing its canonical subcontract factory/period/process binding." };
    }
    if (opening.policy_hash.toLowerCase() !== parent.current_policy_hash.toLowerCase()) {
      return { ok: false, error: "The child capacity allocation uses a different policy." };
    }

    const parentChainOrderId = requireHex32(parent.chain_order_id, "Parent order ID");
    const parentFactoryChainId = requireHex32(parentFactory.chain_organization_id, "Parent factory organization ID");
    const subcontractorChainId = requireHex32(subcontractor.chain_organization_id, "Subcontractor organization ID");
    const buyerChainId = requireHex32(buyer.chain_organization_id, "Buyer organization ID");
    const parentVersionHash = requireHex32(parentVersion.version_hash, "Parent version hash");
    const childVersionHash = requireHex32(childVersion.version_hash, "Child version hash");
    const policyHash = requireHex32(parent.current_policy_hash, "Policy hash");
    const periodId = requireHex32(opening.chain_period_id, "Period ID");
    const processId = requireHex32(opening.chain_process_id, "Process ID");

    const network = getSubcontractNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) {
      return { ok: false, error: `Besu chain ID ${actualChainId} does not match configured chain ID ${network.configuredChainId}.` };
    }

    const [parentState, childState, policy, capacity, complianceScope, processScope, nonce, sequence] = await Promise.all([
      network.client.readContract({ address: network.orderRegistryAddress, abi: subcontractOrderRegistryAbi, functionName: "getOrder", args: [parentChainOrderId] }),
      network.client.readContract({ address: network.orderRegistryAddress, abi: subcontractOrderRegistryAbi, functionName: "getOrder", args: [childChainOrderId] }),
      network.client.readContract({ address: network.subcontractGovernorAddress, abi: subcontractGovernorReadAbi, functionName: "getPolicy", args: [policyHash] }),
      network.client.readContract({ address: network.capacityVaultAddress, abi: subcontractCapacityVaultAbi, functionName: "getCapacityAllocation", args: [chainAllocationId] }),
      network.client.readContract({ address: network.subcontractGovernorAddress, abi: subcontractGovernorReadAbi, functionName: "complianceCredentialScopeHash", args: [subcontractorChainId, policyHash] }),
      network.client.readContract({ address: network.subcontractGovernorAddress, abi: subcontractGovernorReadAbi, functionName: "processCredentialScopeHash", args: [subcontractorChainId, processId, policyHash] }),
      network.client.readContract({ address: network.subcontractGovernorAddress, abi: subcontractGovernorReadAbi, functionName: "nonces", args: [parentFactoryChainId] }),
      nextSubcontractSequence(network.client, network.subcontractGovernorAddress, childChainOrderId),
    ]);

    if (!chainOrderMirrorMatches(parent, parentVersionHash, buyerChainId, parentFactoryChainId, parentState)) {
      return { ok: false, error: "Parent order mirror is stale relative to OrderRegistry." };
    }
    if (!chainOrderMirrorMatches(child, childVersionHash, buyerChainId, subcontractorChainId, childState)) {
      return { ok: false, error: "Child order mirror is stale relative to OrderRegistry." };
    }
    if (!policy.exists) return { ok: false, error: "The shared subcontract policy is not registered on-chain." };
    if (
      !capacity.exists
      || !sameHex(capacity.orderId, childChainOrderId)
      || !sameHex(capacity.factoryOrganizationId, subcontractorChainId)
      || !sameHex(capacity.periodId, periodId)
      || !sameHex(capacity.processId, processId)
      || !sameHex(capacity.policyHash, policyHash)
      || capacity.orderCommitment !== childState.currentOrderCommitment
    ) {
      return { ok: false, error: "The canonical capacity allocation does not match the child order and subcontract production context." };
    }

    const [capacityAuthorized, complianceValid, processValid] = await Promise.all([
      network.client.readContract({
        address: network.capacityVaultAddress,
        abi: subcontractCapacityVaultAbi,
        functionName: "isCapacityAllocationAuthorized",
        args: [chainAllocationId, childChainOrderId, subcontractorChainId, periodId, processId, childState.currentOrderCommitment, policyHash],
      }),
      network.client.readContract({
        address: network.credentialRegistryAddress,
        abi: subcontractCredentialRegistryAbi,
        functionName: "isCredentialValidFor",
        args: [chainComplianceCredentialId, subcontractorChainId, policy.complianceCredentialType, complianceScope],
      }),
      network.client.readContract({
        address: network.credentialRegistryAddress,
        abi: subcontractCredentialRegistryAbi,
        functionName: "isCredentialValidFor",
        args: [chainProcessCredentialId, subcontractorChainId, policy.processCredentialType, processScope],
      }),
    ]);
    if (!capacityAuthorized) return { ok: false, error: "CapacityVault no longer recognizes the child allocation as authorized." };
    if (!complianceValid) return { ok: false, error: "The compliance credential does not satisfy the registered subcontract policy and scope." };
    if (!processValid) return { ok: false, error: "The process credential does not satisfy the registered subcontract policy and process scope." };

    const { data: activeJobs, error: jobsError } = await service
      .from("subcontract_authorization_jobs")
      .select("id,status,created_by")
      .eq("child_order_id", child.id)
      .in("status", ["prepared", "signed", "submitting", "submitted"]);
    if (jobsError) throw jobsError;
    const blocking = (activeJobs ?? []).find((job) => job.status !== "prepared" || job.created_by !== viewer.userId);
    if (blocking) return { ok: false, error: "This child order already has a subcontract authorization in progress." };
    for (const prepared of activeJobs ?? []) {
      const { error: deleteError } = await service.from("subcontract_authorization_jobs").delete().eq("id", prepared.id).eq("status", "prepared");
      if (deleteError) throw deleteError;
    }

    const deadlineSeconds = Math.floor(Date.now() / 1000) + 15 * 60;
    const deadline = new Date(deadlineSeconds * 1000).toISOString();
    const { data: job, error: insertError } = await service.from("subcontract_authorization_jobs").insert({
      parent_order_id: parent.id,
      child_order_id: child.id,
      parent_chain_order_id: parentChainOrderId,
      child_chain_order_id: childChainOrderId,
      buyer_organization_id: parent.buyer_organization_id,
      parent_factory_organization_id: parent.factory_organization_id,
      subcontractor_organization_id: child.factory_organization_id,
      parent_version: parent.current_version,
      child_version: child.current_version,
      parent_version_hash: parentVersionHash,
      child_version_hash: childVersionHash,
      period_id: periodId,
      process_id: processId,
      policy_hash: policyHash,
      compliance_credential_id: complianceCredential.id,
      chain_compliance_credential_id: chainComplianceCredentialId,
      process_credential_id: processCredential.id,
      chain_process_credential_id: chainProcessCredentialId,
      capacity_allocation_id: allocation.id,
      chain_capacity_allocation_id: chainAllocationId,
      sequence,
      nonce: nonce.toString(),
      deadline,
      created_by: viewer.userId,
      status: "prepared",
    }).select("*").single();
    if (insertError) throw insertError;

    return {
      ok: true,
      authorization: authorizationFromSubcontractJob(job, actualChainId, network.subcontractGovernorAddress, parentFactoryChainId, subcontractorChainId),
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function submitSubcontractSignatureAction(input: unknown): Promise<SubcontractSignatureResult> {
  try {
    const viewer = await requireConsortiumViewer();
    const parsed = signatureSchema.parse(input);
    const supabase = await createClient();
    const service = createServiceClient();
    const { data: job, error: jobError } = await supabase.from("subcontract_authorization_jobs").select("*").eq("id", parsed.jobId).maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.status !== "prepared" || job.created_by !== viewer.userId) {
      return { ok: false, error: "Prepared subcontract authorization is no longer available to this signer." };
    }
    if (new Date(job.deadline).getTime() <= Date.now()) return { ok: false, error: "The subcontract signature deadline expired. Prepare a fresh authorization." };

    const membership = viewer.memberships.find((item) => item.organization_id === job.parent_factory_organization_id);
    if (!membership || !hasOperationalRole(membership) || membership.organization.role !== "factory" || membership.organization.status !== "active") {
      return { ok: false, error: "An active parent-factory operator or signer membership is required." };
    }
    const { data: subcontractor, error: subcontractorError } = await service.from("organizations").select("chain_organization_id,status,role").eq("id", job.subcontractor_organization_id).maybeSingle();
    if (subcontractorError) throw subcontractorError;
    if (!subcontractor || subcontractor.role !== "factory" || subcontractor.status !== "active") return { ok: false, error: "The subcontractor factory is no longer active." };

    const parentFactoryChainId = requireHex32(membership.organization.chain_organization_id, "Parent factory organization ID");
    const subcontractorChainId = requireHex32(subcontractor.chain_organization_id, "Subcontractor organization ID");
    const network = getSubcontractNetwork();
    const actualChainId = await network.client.getChainId();
    if (actualChainId !== network.configuredChainId) return { ok: false, error: "Configured Besu chain is unavailable or has the wrong chain ID." };

    const authorization = authorizationFromSubcontractJob(job, actualChainId, network.subcontractGovernorAddress, parentFactoryChainId, subcontractorChainId);
    const signature = parsed.signature as Hex;
    const signer = await recoverTypedDataAddress({ ...buildSubcontractTypedData(authorization), signature });
    const [signerOrganization, signerActive, currentNonce] = await Promise.all([
      network.client.readContract({ address: network.organizationRegistryAddress, abi: subcontractOrganizationRegistryAbi, functionName: "organizationOfAccount", args: [signer] }),
      network.client.readContract({ address: network.organizationRegistryAddress, abi: subcontractOrganizationRegistryAbi, functionName: "isActiveAccount", args: [signer] }),
      network.client.readContract({ address: network.subcontractGovernorAddress, abi: subcontractGovernorReadAbi, functionName: "nonces", args: [parentFactoryChainId] }),
    ]);
    if (!signerActive || signerOrganization.toLowerCase() !== parentFactoryChainId.toLowerCase()) {
      return { ok: false, error: "The connected wallet is not an active signer for the parent factory organization." };
    }
    if (currentNonce.toString() !== job.nonce) {
      return { ok: false, error: "The parent-factory nonce changed before the signature was stored. Prepare a fresh authorization." };
    }

    await network.client.simulateContract({
      address: network.subcontractGovernorAddress,
      abi: subcontractGovernorReadAbi,
      functionName: "authorizeSubcontract",
      args: [subcontractAuthorizationMessage(authorization), signature],
      account: signer,
    });

    const { data: updated, error: updateError } = await supabase.from("subcontract_authorization_jobs").update({
      parent_factory_signature: signature,
      status: "signed",
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("status", "prepared").eq("created_by", viewer.userId).select("id").maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return { ok: false, error: "Authorization changed before the signature could be stored." };

    revalidatePath("/app/subcontracts");
    revalidatePath(`/app/orders/${job.parent_order_id}`);
    revalidatePath(`/app/orders/${job.child_order_id}`);
    return { ok: true, signer };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
