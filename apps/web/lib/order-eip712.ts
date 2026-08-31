import type { Address, Hex } from "viem";

export const ORDER_VERSION_TYPES = {
  OrderVersion: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "primaryFactoryOrganizationId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "previousVersionHash", type: "bytes32" },
    { name: "orderCommitment", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "expectedVersion", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export type PreparedOrderAuthorization = {
  jobId: string;
  orderId: string;
  chainId: number;
  orderRegistryAddress: Address;
  buyerOrganizationId: Hex;
  factoryOrganizationId: Hex;
  version: number;
  previousVersionHash: Hex;
  orderCommitment: string;
  policyHash: Hex;
  nonce: string;
  deadline: string;
};

export type PreparedOrderCancellation = {
  jobId: string;
  orderId: Hex;
  chainId: number;
  orderRegistryAddress: Address;
  buyerOrganizationId: Hex;
  expectedVersion: number;
  nonce: string;
  deadline: string;
};

function orderRegistryDomain(chainId: number, orderRegistryAddress: Address) {
  return {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId,
    verifyingContract: orderRegistryAddress,
  } as const;
}

export function buildOrderTypedData(input: PreparedOrderAuthorization) {
  return {
    domain: orderRegistryDomain(input.chainId, input.orderRegistryAddress),
    types: ORDER_VERSION_TYPES,
    primaryType: "OrderVersion" as const,
    message: {
      orderId: input.orderId as Hex,
      buyerOrganizationId: input.buyerOrganizationId,
      primaryFactoryOrganizationId: input.factoryOrganizationId,
      version: input.version,
      previousVersionHash: input.previousVersionHash,
      orderCommitment: BigInt(input.orderCommitment),
      policyHash: input.policyHash,
      nonce: BigInt(input.nonce),
      deadline: BigInt(input.deadline),
    },
  };
}

export function buildCancelOrderTypedData(input: PreparedOrderCancellation) {
  return {
    domain: orderRegistryDomain(input.chainId, input.orderRegistryAddress),
    types: CANCEL_ORDER_TYPES,
    primaryType: "CancelOrder" as const,
    message: {
      orderId: input.orderId,
      buyerOrganizationId: input.buyerOrganizationId,
      expectedVersion: input.expectedVersion,
      nonce: BigInt(input.nonce),
      deadline: BigInt(input.deadline),
    },
  };
}
