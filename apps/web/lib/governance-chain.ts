import { parseAbi, type Address, type Hex } from "viem";

export const governanceProposalTypes = {
  organizationSuspension: 1,
  organizationRestore: 2,
  primaryAccountRotation: 3,
  protectedIdentityDisclosure: 4,
  charterPolicyUpdate: 5,
} as const;

export type GovernanceProposalType = typeof governanceProposalTypes[keyof typeof governanceProposalTypes];

export const threadProofCharterAbi = parseAbi([
  "function createProposal(uint8 proposalType,bytes32 actionHash,bytes32 metadataHash) returns (bytes32 proposalId)",
  "function approveProposal(bytes32 proposalId)",
  "function cancelProposal(bytes32 proposalId)",
  "function executeOrganizationStatus(bytes32 proposalId,bytes32 organizationId,uint8 newStatus)",
  "function executePrimaryAccountRotation(bytes32 proposalId,bytes32 organizationId,address newAccount)",
  "function executeProtectedIdentityDisclosure(bytes32 proposalId,bytes32 subjectReference,bytes32 evidenceHash)",
  "function executePolicyUpdate(bytes32 proposalId,uint8 targetProposalType,(uint8 threshold,uint8 eligibleMask,uint8 requiredMask,uint64 timelockSeconds,uint64 votingPeriodSeconds,bool exists) newPolicy)",
  "function hashOrganizationStatusAction(bytes32 organizationId,uint8 newStatus) pure returns (bytes32)",
  "function hashPrimaryAccountRotationAction(bytes32 organizationId,address newAccount) pure returns (bytes32)",
  "function hashProtectedIdentityDisclosureAction(bytes32 subjectReference,bytes32 evidenceHash) pure returns (bytes32)",
  "function hashPolicyUpdateAction(uint8 targetProposalType,uint8 threshold,uint8 eligibleMask,uint8 requiredMask,uint64 timelockSeconds,uint64 votingPeriodSeconds,uint64 expectedPolicyVersion) pure returns (bytes32)",
  "function policyVersion() view returns (uint64)",
  "function getProposalState(bytes32 proposalId) view returns (uint8)",
]);

export type GovernanceTargetOrganization = {
  chainOrganizationId: Hex;
  displayName: string;
  role: string;
  status: string;
};

export type GovernanceConsoleConfig = {
  charterAddress: Address;
  chainId: number;
};
