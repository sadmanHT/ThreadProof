import { parseAbi, type Address, type Hex } from "viem";

export const credentialRegistryLifecycleAbi = parseAbi([
  "function revokeCredential(bytes32 credentialId)",
  "function setCredentialStatus(bytes32 credentialId,uint8 newStatus)",
  "function SUSPENDER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);

export type CredentialLifecycleItem = {
  credentialId: Hex;
  label: string;
  subjectName: string;
  issuerName: string;
  status: string;
};

export type CredentialLifecycleConfig = {
  credentialRegistryAddress: Address;
  chainId: number;
};
