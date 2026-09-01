import { parseAbi, type Address, type Hex } from "viem";

export const credentialRegistryLifecycleAbi = parseAbi([
  "function issueCredential(bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil)",
  "function revokeCredential(bytes32 credentialId)",
  "function setCredentialStatus(bytes32 credentialId,uint8 newStatus)",
  "function getCredential(bytes32 credentialId) view returns ((bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 issuerOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil,uint8 status))",
  "function isCredentialActive(bytes32 credentialId) view returns (bool)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function SUSPENDER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);

export const subcontractCredentialPolicyAbi = parseAbi([
  "function getPolicy(bytes32 policyHash) view returns ((uint8 maxDepth,bytes32 complianceCredentialType,bytes32 processCredentialType,bool exists))",
  "function complianceCredentialScopeHash(bytes32 subcontractorOrganizationId,bytes32 policyHash) pure returns (bytes32)",
  "function processCredentialScopeHash(bytes32 subcontractorOrganizationId,bytes32 processId,bytes32 policyHash) pure returns (bytes32)",
]);

export type CredentialLifecycleItem = {
  credentialId: Hex;
  label: string;
  subjectName: string;
  issuerName: string;
  status: string;
};

export type CredentialSubjectItem = {
  organizationId: string;
  chainOrganizationId: Hex;
  name: string;
};

export type SubcontractCredentialPolicyItem = {
  policyHash: Hex;
  maxDepth: number;
  complianceCredentialType: Hex;
  processCredentialType: Hex;
};

export type CredentialLifecycleConfig = {
  credentialRegistryAddress: Address;
  subcontractGovernorAddress: Address | null;
  chainId: number;
};
