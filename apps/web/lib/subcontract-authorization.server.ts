import "server-only";

import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { requireHex32 } from "@/lib/order-authorization.server";
import type { PreparedSubcontractAuthorization } from "@/lib/subcontract-eip712";

export const subcontractGovernorReadAbi = parseAbi([
  "function nonces(bytes32 parentFactoryOrganizationId) view returns (uint256)",
  "function getPolicy(bytes32 policyHash) view returns ((uint8 maxDepth,bytes32 complianceCredentialType,bytes32 processCredentialType,bool exists))",
  "function getSubcontractAuthorization(bytes32 childOrderId) view returns ((bytes32 parentOrderId,bytes32 childOrderId,bytes32 buyerOrganizationId,bytes32 parentFactoryOrganizationId,bytes32 subcontractorOrganizationId,bytes32 periodId,bytes32 processId,bytes32 policyHash,bytes32 parentVersionHash,bytes32 childVersionHash,bytes32 complianceCredentialId,bytes32 processCredentialId,bytes32 capacityAllocationId,bytes32 capacityStateKey,uint256 childOrderCommitment,uint256 capacityNullifier,uint32 sequence,uint8 depth,address parentSigner,uint64 authorizedAt,bool exists))",
  "function complianceCredentialScopeHash(bytes32 subcontractorOrganizationId,bytes32 policyHash) pure returns (bytes32)",
  "function processCredentialScopeHash(bytes32 subcontractorOrganizationId,bytes32 processId,bytes32 policyHash) pure returns (bytes32)",
  "function isSubcontractAuthorizationActive(bytes32 childOrderId) view returns (bool)",
  "function authorizeSubcontract((bytes32 parentOrderId,bytes32 childOrderId,bytes32 parentFactoryOrganizationId,bytes32 subcontractorOrganizationId,bytes32 periodId,bytes32 processId,bytes32 policyHash,bytes32 parentVersionHash,bytes32 childVersionHash,bytes32 complianceCredentialId,bytes32 processCredentialId,bytes32 capacityAllocationId,uint32 sequence,uint256 nonce,uint64 deadline) authorization,bytes parentFactorySignature)",
]);

export const subcontractOrderRegistryAbi = parseAbi([
  "function getOrder(bytes32 orderId) view returns ((bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 currentVersion,bytes32 currentVersionHash,uint256 currentOrderCommitment,bytes32 currentPolicyHash,uint64 updatedAt,uint8 status))",
]);

export const subcontractCredentialRegistryAbi = parseAbi([
  "function isCredentialValidFor(bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 credentialType,bytes32 scopeHash) view returns (bool)",
]);

export const subcontractCapacityVaultAbi = parseAbi([
  "function getCapacityAllocation(bytes32 allocationId) view returns ((bytes32 stateKey,bytes32 orderId,bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,bytes32 capacityCredentialId,uint256 orderCommitment,bytes32 policyHash,uint256 nullifier,uint32 circuitVersion,uint64 authorizedAt,bool exists))",
  "function isCapacityAllocationAuthorized(bytes32 allocationId,bytes32 orderId,bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,uint256 orderCommitment,bytes32 policyHash) view returns (bool)",
]);

export const subcontractOrganizationRegistryAbi = parseAbi([
  "function organizationOfAccount(address account) view returns (bytes32)",
  "function isActiveAccount(address account) view returns (bool)",
]);

function address(value: string | undefined, label: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${label} is not configured.`);
  }
  return value as Address;
}

export function getSubcontractNetwork() {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  if (!rpcUrl) throw new Error("THREADPROOF_RPC_URL is not configured.");
  const configuredChainId = Number(process.env.THREADPROOF_CHAIN_ID ?? process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? "0");
  if (!Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) throw new Error("THREADPROOF_CHAIN_ID is not configured.");

  return {
    rpcUrl,
    configuredChainId,
    organizationRegistryAddress: address(process.env.THREADPROOF_REGISTRY_ADDRESS, "ThreadProofRegistry address"),
    credentialRegistryAddress: address(process.env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS ?? process.env.CREDENTIAL_REGISTRY_ADDRESS, "CredentialRegistry address"),
    orderRegistryAddress: address(process.env.THREADPROOF_ORDER_REGISTRY_ADDRESS ?? process.env.ORDER_REGISTRY_ADDRESS, "OrderRegistry address"),
    capacityVaultAddress: address(process.env.THREADPROOF_CAPACITY_VAULT_ADDRESS ?? process.env.CAPACITY_VAULT_ADDRESS, "CapacityVault address"),
    subcontractGovernorAddress: address(process.env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS ?? process.env.SUBCONTRACT_GOVERNOR_ADDRESS, "SubcontractGovernor address"),
    client: createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) }),
  };
}

export function authorizationFromSubcontractJob(
  job: {
    id: string;
    parent_chain_order_id: string;
    child_chain_order_id: string;
    parent_version_hash: string;
    child_version_hash: string;
    period_id: string;
    process_id: string;
    policy_hash: string;
    chain_compliance_credential_id: string;
    chain_process_credential_id: string;
    chain_capacity_allocation_id: string;
    sequence: number;
    nonce: string;
    deadline: string;
  },
  chainId: number,
  subcontractGovernorAddress: Address,
  parentFactoryOrganizationId: Hex,
  subcontractorOrganizationId: Hex,
): PreparedSubcontractAuthorization {
  return {
    jobId: job.id,
    chainId,
    subcontractGovernorAddress,
    parentOrderId: requireHex32(job.parent_chain_order_id, "Parent order ID"),
    childOrderId: requireHex32(job.child_chain_order_id, "Child order ID"),
    parentFactoryOrganizationId,
    subcontractorOrganizationId,
    periodId: requireHex32(job.period_id, "Period ID"),
    processId: requireHex32(job.process_id, "Process ID"),
    policyHash: requireHex32(job.policy_hash, "Policy hash"),
    parentVersionHash: requireHex32(job.parent_version_hash, "Parent version hash"),
    childVersionHash: requireHex32(job.child_version_hash, "Child version hash"),
    complianceCredentialId: requireHex32(job.chain_compliance_credential_id, "Compliance credential ID"),
    processCredentialId: requireHex32(job.chain_process_credential_id, "Process credential ID"),
    capacityAllocationId: requireHex32(job.chain_capacity_allocation_id, "Capacity allocation ID"),
    sequence: job.sequence,
    nonce: job.nonce,
    deadline: Math.floor(new Date(job.deadline).getTime() / 1000).toString(),
  };
}

export async function nextSubcontractSequence(client: ReturnType<typeof createPublicClient>, governor: Address, childOrderId: Hex) {
  try {
    const existing = await client.readContract({
      address: governor,
      abi: subcontractGovernorReadAbi,
      functionName: "getSubcontractAuthorization",
      args: [childOrderId],
    });
    return Number(existing.sequence) + 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UnknownSubcontractAuthorization")) return 1;
    throw error;
  }
}
