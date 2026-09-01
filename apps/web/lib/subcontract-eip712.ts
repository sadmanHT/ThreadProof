import type { Address, Hex } from "viem";

export type PreparedSubcontractAuthorization = {
  jobId: string;
  chainId: number;
  subcontractGovernorAddress: Address;
  parentOrderId: Hex;
  childOrderId: Hex;
  parentFactoryOrganizationId: Hex;
  subcontractorOrganizationId: Hex;
  periodId: Hex;
  processId: Hex;
  policyHash: Hex;
  parentVersionHash: Hex;
  childVersionHash: Hex;
  complianceCredentialId: Hex;
  processCredentialId: Hex;
  capacityAllocationId: Hex;
  sequence: number;
  nonce: string;
  deadline: string;
};

export const subcontractAuthorizationTypes = {
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

export function subcontractAuthorizationMessage(authorization: PreparedSubcontractAuthorization) {
  return {
    parentOrderId: authorization.parentOrderId,
    childOrderId: authorization.childOrderId,
    parentFactoryOrganizationId: authorization.parentFactoryOrganizationId,
    subcontractorOrganizationId: authorization.subcontractorOrganizationId,
    periodId: authorization.periodId,
    processId: authorization.processId,
    policyHash: authorization.policyHash,
    parentVersionHash: authorization.parentVersionHash,
    childVersionHash: authorization.childVersionHash,
    complianceCredentialId: authorization.complianceCredentialId,
    processCredentialId: authorization.processCredentialId,
    capacityAllocationId: authorization.capacityAllocationId,
    sequence: authorization.sequence,
    nonce: BigInt(authorization.nonce),
    deadline: BigInt(authorization.deadline),
  } as const;
}

export function buildSubcontractTypedData(authorization: PreparedSubcontractAuthorization) {
  return {
    domain: {
      name: "ThreadProof SubcontractGovernor",
      version: "1",
      chainId: authorization.chainId,
      verifyingContract: authorization.subcontractGovernorAddress,
    },
    types: subcontractAuthorizationTypes,
    primaryType: "SubcontractAuthorization" as const,
    message: subcontractAuthorizationMessage(authorization),
  } as const;
}
