import { parseAbi } from "viem";

export const capacityVaultAbi = parseAbi([
  "function spendCapacity((bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,bytes32 orderId,bytes32 policyHash,uint256 oldCapacityCommitment,uint256 newCapacityCommitment,uint256 orderCommitment,uint256 nullifier,uint32 circuitVersion) request,uint256[2] a,uint256[2][2] b,uint256[2] c)",
  "function getCapacityState(bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId) view returns ((uint256 activeCommitment,bytes32 capacityCredentialId,bytes32 policyHash,uint32 circuitVersion,uint64 updatedAt,bool active))",
  "event CapacityCertified(bytes32 indexed stateKey,bytes32 indexed factoryOrganizationId,bytes32 indexed capacityCredentialId,bytes32 periodId,bytes32 processId,uint256 commitment,bytes32 policyHash,uint32 circuitVersion)",
  "event CapacitySpent(bytes32 indexed stateKey,bytes32 indexed orderId,uint256 indexed nullifier,uint256 oldCommitment,uint256 newCommitment,uint256 orderCommitment,uint32 circuitVersion)",
  "event CapacityAllocationRecorded(bytes32 indexed allocationId,bytes32 indexed orderId,bytes32 indexed factoryOrganizationId,bytes32 stateKey,uint256 nullifier)",
  "event VerifierRegistered(uint32 indexed circuitVersion,address indexed verifier)",
]);

export const orderRegistryAbi = parseAbi([
  "function submitOrderVersion((bytes32 orderId,bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 version,bytes32 previousVersionHash,uint256 orderCommitment,bytes32 policyHash,uint256 nonce,uint64 deadline) authorization,bytes buyerSignature) returns (bytes32 versionHash)",
  "function nonces(bytes32 buyerOrganizationId) view returns (uint256)",
  "function getOrder(bytes32 orderId) view returns ((bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 currentVersion,bytes32 currentVersionHash,uint256 currentOrderCommitment,bytes32 currentPolicyHash,uint64 updatedAt,uint8 status))",
  "event OrderVersionRecorded(bytes32 indexed orderId,bytes32 indexed buyerOrganizationId,bytes32 indexed primaryFactoryOrganizationId,uint32 version,bytes32 versionHash,uint256 orderCommitment,bytes32 policyHash,uint256 nonce,address buyerSigner)",
  "event OrderCancelled(bytes32 indexed orderId,bytes32 indexed buyerOrganizationId,uint32 indexed version,uint256 nonce,address buyerSigner)",
]);

export const subcontractGovernorAbi = parseAbi([
  "event SubcontractPolicyRegistered(bytes32 indexed policyHash,uint8 maxDepth,bytes32 complianceCredentialType,bytes32 processCredentialType)",
  "event SubcontractAuthorized(bytes32 indexed childOrderId,bytes32 indexed parentOrderId,bytes32 indexed subcontractorOrganizationId,bytes32 buyerOrganizationId,bytes32 parentFactoryOrganizationId,uint8 depth,uint32 sequence,bytes32 capacityAllocationId,address parentSigner)",
]);

export const threadProofCharterEventsAbi = parseAbi([
  "event ProposalCreated(bytes32 indexed proposalId,uint8 indexed proposalType,bytes32 indexed proposerOrganizationId,bytes32 actionHash,bytes32 metadataHash,uint64 policyVersion,uint8 approvalsRequired,uint64 expiresAt)",
  "event ProposalApprovalRecorded(bytes32 indexed proposalId,bytes32 indexed organizationId,uint8 indexed constituency,uint8 approvalsReceived,uint8 approvalsRequired,uint8 approvalMask)",
  "event ProposalThresholdReached(bytes32 indexed proposalId,uint64 approvedAt,uint64 executeAfter)",
  "event ProposalCancelled(bytes32 indexed proposalId,bytes32 indexed proposerOrganizationId)",
  "event ProposalExecuted(bytes32 indexed proposalId,uint8 indexed proposalType,address indexed executor)",
  "event CharterPolicyUpdated(uint8 indexed proposalType,uint64 indexed newPolicyVersion,uint8 threshold,uint8 eligibleMask,uint8 requiredMask,uint64 timelockSeconds,uint64 votingPeriodSeconds)",
  "event ProtectedIdentityDisclosureAuthorized(bytes32 indexed proposalId,bytes32 indexed subjectReference,bytes32 indexed evidenceHash)",
]);

export const threadProofRegistryAbi = parseAbi([
  "function organizationOfAccount(address account) view returns (bytes32)",
  "function isActiveAccount(address account) view returns (bool)",
]);

export const registryEventsAbi = parseAbi([
  "event OrganizationRegistered(bytes32 indexed organizationId,address indexed primaryAccount,uint8 role,bytes32 metadataHash)",
  "event OrganizationStatusChanged(bytes32 indexed organizationId,uint8 previousStatus,uint8 newStatus)",
  "event OrganizationPrimaryAccountRotated(bytes32 indexed organizationId,address indexed previousAccount,address indexed newAccount)",
  "event OrganizationMetadataUpdated(bytes32 indexed organizationId,bytes32 metadataHash)",
]);

export const credentialEventsAbi = parseAbi([
  "event CredentialIssued(bytes32 indexed credentialId,bytes32 indexed subjectOrganizationId,bytes32 indexed issuerOrganizationId,bytes32 credentialType,uint64 validFrom,uint64 validUntil,bytes32 digest,bytes32 scopeHash)",
  "event CredentialStatusChanged(bytes32 indexed credentialId,uint8 previousStatus,uint8 newStatus)",
]);

export const protocolEventsAbi = [
  ...registryEventsAbi,
  ...credentialEventsAbi,
  ...orderRegistryAbi.filter((item) => item.type === "event"),
  ...capacityVaultAbi.filter((item) => item.type === "event"),
  ...subcontractGovernorAbi.filter((item) => item.type === "event"),
  ...threadProofCharterEventsAbi,
] as const;
