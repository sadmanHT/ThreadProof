import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { capacityVaultAbi } from "./chain.js";

export type CanonicalCapacityState = {
  activeCommitment: bigint;
  capacityCredentialId: Hex;
  policyHash: Hex;
  circuitVersion: number;
  updatedAt: bigint;
  active: boolean;
};

export type ExpectedCapacityOpening = {
  factoryOrganizationId: Hex;
  periodId: Hex;
  processId: Hex;
  activeCommitment: bigint;
  capacityCredentialId: Hex;
  policyHash: Hex;
  circuitVersion: number;
};

export class StaleCanonicalCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCanonicalCapacityError";
  }
}

function sameHex(left: Hex, right: Hex) {
  return left.toLowerCase() === right.toLowerCase();
}

export function assertCapacityStateMatches(
  state: CanonicalCapacityState,
  expected: ExpectedCapacityOpening,
) {
  if (!state.active) {
    throw new StaleCanonicalCapacityError("Canonical CapacityVault state is inactive.");
  }
  if (state.activeCommitment !== expected.activeCommitment) {
    throw new StaleCanonicalCapacityError(
      "Canonical CapacityVault commitment no longer matches the private mirror.",
    );
  }
  if (!sameHex(state.capacityCredentialId, expected.capacityCredentialId)) {
    throw new StaleCanonicalCapacityError(
      "Canonical CapacityVault credential no longer matches the private mirror.",
    );
  }
  if (!sameHex(state.policyHash, expected.policyHash)) {
    throw new StaleCanonicalCapacityError(
      "Canonical CapacityVault policy no longer matches the private mirror.",
    );
  }
  if (state.circuitVersion !== expected.circuitVersion) {
    throw new StaleCanonicalCapacityError(
      "Canonical CapacityVault circuit version no longer matches the proof job.",
    );
  }
}

export async function assertCanonicalCapacityOpening(args: {
  rpcUrl: string;
  vaultAddress: Address;
  expectedChainId?: number;
  expected: ExpectedCapacityOpening;
}) {
  const client = createPublicClient({
    transport: http(args.rpcUrl, { timeout: 8_000, retryCount: 2, retryDelay: 250 }),
  });
  const chainId = await client.getChainId();
  if (args.expectedChainId !== undefined && chainId !== args.expectedChainId) {
    throw new Error(
      `Canonical RPC chain ID ${chainId} does not match configured chain ID ${args.expectedChainId}.`,
    );
  }

  const state = await client.readContract({
    address: args.vaultAddress,
    abi: capacityVaultAbi,
    functionName: "getCapacityState",
    args: [
      args.expected.factoryOrganizationId,
      args.expected.periodId,
      args.expected.processId,
    ],
  });

  const normalized: CanonicalCapacityState = {
    activeCommitment: state.activeCommitment,
    capacityCredentialId: state.capacityCredentialId,
    policyHash: state.policyHash,
    circuitVersion: state.circuitVersion,
    updatedAt: state.updatedAt,
    active: state.active,
  };
  assertCapacityStateMatches(normalized, args.expected);
  return normalized;
}
