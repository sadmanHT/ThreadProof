import { parseAbi, type Address, type Hex } from "viem";

export const credentialRegistryWriteAbi = parseAbi([
  "function issueCredential(bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil)",
]);

export const capacityVaultWriteAbi = parseAbi([
  "function certifyCapacity(bytes32 factoryOrganizationId,bytes32 periodId,bytes32 processId,uint256 initialCommitment,bytes32 capacityCredentialId,bytes32 policyHash,uint32 circuitVersion)",
]);

export type PreparedCapacityCertification = {
  jobId: string;
  chainId: number;
  credentialRegistryAddress: Address;
  capacityVaultAddress: Address;
  credential: {
    credentialId: Hex;
    factoryOrganizationId: Hex;
    credentialType: Hex;
    digest: Hex;
    scopeHash: Hex;
    validFrom: string;
    validUntil: string;
  };
  certification: {
    factoryOrganizationId: Hex;
    periodId: Hex;
    processId: Hex;
    initialCommitment: string;
    capacityCredentialId: Hex;
    policyHash: Hex;
    circuitVersion: number;
    stateKey: Hex;
  };
};
