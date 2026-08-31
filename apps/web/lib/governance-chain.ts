import { parseAbi, type Address, type Hex } from "viem";

export const governanceProposalTypes = {
  organizationSuspension: 1,
  organizationRestore: 2,
  primaryAccountRotation: 3,
  protectedIdentityDisclosure: 4,
  charterPolicyUpdate: 5,
  factoryOnboarding: 6,
  protocolRoleUpdate: 7,
  verifierRegistration: 8,
  subcontractPolicyRegistration: 9,
  emergencyPause: 10,
  emergencyUnpause: 11,
  credentialSuspension: 12,
  credentialRestore: 13,
} as const;

export const governanceEmergencyTargets = {
  capacityVault: 1,
  subcontractGovernor: 2,
} as const;

export const governanceOperationalRoles = {
  credentialIssuer: "credential_issuer",
  capacityCertifier: "capacity_certifier",
  capacityRelayer: "capacity_relayer",
} as const;

export type GovernanceProposalType = typeof governanceProposalTypes[keyof typeof governanceProposalTypes];
export type GovernanceEmergencyTarget = typeof governanceEmergencyTargets[keyof typeof governanceEmergencyTargets];
export type GovernanceOperationalRole = typeof governanceOperationalRoles[keyof typeof governanceOperationalRoles];

export const threadProofCharterAbi = parseAbi([
  "function createProposal(uint8 proposalType,bytes32 actionHash,bytes32 metadataHash) returns (bytes32 proposalId)",
  "function approveProposal(bytes32 proposalId)",
  "function cancelProposal(bytes32 proposalId)",
  "function executeOrganizationStatus(bytes32 proposalId,bytes32 organizationId,uint8 newStatus)",
  "function executePrimaryAccountRotation(bytes32 proposalId,bytes32 organizationId,address newAccount)",
  "function executeProtectedIdentityDisclosure(bytes32 proposalId,bytes32 subjectReference,bytes32 evidenceHash)",
  "function executeFactoryOnboarding(bytes32 proposalId,bytes32 organizationId,address primaryAccount,bytes32 metadataHash)",
  "function executePolicyUpdate(bytes32 proposalId,uint8 targetProposalType,(uint8 threshold,uint8 eligibleMask,uint8 requiredMask,uint64 timelockSeconds,uint64 votingPeriodSeconds,bool exists) newPolicy)",
  "function executeProtocolRoleUpdate(bytes32 proposalId,address target,bytes32 role,address account,bool grant)",
  "function executeVerifierRegistration(bytes32 proposalId,uint32 circuitVersion,address verifierAddress,bytes32 circuitArtifactHash,bytes32 verificationKeyHash)",
  "function executeSubcontractPolicyRegistration(bytes32 proposalId,bytes32 policyHash,uint8 maxDepth,bytes32 complianceCredentialType,bytes32 processCredentialType)",
  "function executeEmergencyControl(bytes32 proposalId,uint8 target)",
  "function executeCredentialStatus(bytes32 proposalId,bytes32 credentialId,uint8 newStatus)",
  "function hashOrganizationStatusAction(bytes32 organizationId,uint8 newStatus) pure returns (bytes32)",
  "function hashPrimaryAccountRotationAction(bytes32 organizationId,address newAccount) pure returns (bytes32)",
  "function hashProtectedIdentityDisclosureAction(bytes32 subjectReference,bytes32 evidenceHash) pure returns (bytes32)",
  "function hashFactoryOnboardingAction(bytes32 organizationId,address primaryAccount,bytes32 metadataHash) pure returns (bytes32)",
  "function hashPolicyUpdateAction(uint8 targetProposalType,uint8 threshold,uint8 eligibleMask,uint8 requiredMask,uint64 timelockSeconds,uint64 votingPeriodSeconds,uint64 expectedPolicyVersion) pure returns (bytes32)",
  "function hashProtocolRoleAction(address target,bytes32 role,address account,bool grant) pure returns (bytes32)",
  "function hashVerifierRegistrationAction(uint32 circuitVersion,address verifierAddress,bytes32 circuitArtifactHash,bytes32 verificationKeyHash) pure returns (bytes32)",
  "function hashSubcontractPolicyAction(bytes32 policyHash,uint8 maxDepth,bytes32 complianceCredentialType,bytes32 processCredentialType) pure returns (bytes32)",
  "function hashEmergencyControlAction(uint8 target,bool pauseState) pure returns (bytes32)",
  "function hashCredentialStatusAction(bytes32 credentialId,uint8 newStatus) pure returns (bytes32)",
  "function CREDENTIAL_ISSUER_ROLE() view returns (bytes32)",
  "function CAPACITY_CERTIFIER_ROLE() view returns (bytes32)",
  "function CAPACITY_RELAYER_ROLE() view returns (bytes32)",
  "function credentialRegistry() view returns (address)",
  "function capacityVault() view returns (address)",
  "function subcontractGovernor() view returns (address)",
  "function emergencyTargetAddress(uint8 target) view returns (address)",
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
