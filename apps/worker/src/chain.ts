import { parseAbi } from "viem";

export const capacityVaultAbi = parseAbi([
  "function spendCapacity((bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,bytes32 orderId,bytes32 policyHash,uint256 oldCapacityCommitment,uint256 newCapacityCommitment,uint256 orderCommitment,uint256 nullifier,uint32 circuitVersion) request,uint256[2] a,uint256[2][2] b,uint256[2] c)",
  "function getCapacityState(bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId) view returns ((uint256 activeCommitment,bytes32 capacityCredentialId,bytes32 policyHash,uint32 circuitVersion,uint64 updatedAt,bool active))",
  "event CapacityCertified(bytes32 indexed stateKey,bytes32 indexed factoryOrganizationId,bytes32 indexed capacityCredentialId,bytes32 periodId,bytes32 processId,uint256 commitment,bytes32 policyHash,uint32 circuitVersion)",
  "event CapacitySpent(bytes32 indexed stateKey,bytes32 indexed orderId,uint256 indexed nullifier,uint256 oldCommitment,uint256 newCommitment,uint256 orderCommitment,uint32 circuitVersion)",
  "event VerifierRegistered(uint32 indexed circuitVersion,address indexed verifier)",
]);

export const orderRegistryAbi = parseAbi([
  "function submitOrderVersion((bytes32 orderId,bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 version,bytes32 previousVersionHash,uint256 orderCommitment,bytes32 policyHash,uint256 nonce,uint64 deadline) authorization,bytes buyerSignature) returns (bytes32 versionHash)",
  "function nonces(bytes32 buyerOrganizationId) view returns (uint256)",
  "event OrderVersionRecorded(bytes32 indexed orderId,bytes32 indexed buyerOrganizationId,bytes32 indexed primaryFactoryOrganizationId,uint32 version,bytes32 versionHash,uint256 orderCommitment,bytes32 policyHash,uint256 nonce,address buyerSigner)",
  "event OrderCancelled(bytes32 indexed orderId,bytes32 indexed buyerOrganizationId,uint32 indexed version,uint256 nonce,address buyerSigner)",
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
] as const;
