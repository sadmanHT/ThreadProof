import "server-only";

import { createCipheriv, randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
export const HEX32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const orderRegistryReadAbi = parseAbi([
  "function nonces(bytes32 buyerOrganizationId) view returns (uint256)",
  "function getOrder(bytes32 orderId) view returns ((bytes32 buyerOrganizationId,bytes32 primaryFactoryOrganizationId,uint32 currentVersion,bytes32 currentVersionHash,uint256 currentOrderCommitment,bytes32 currentPolicyHash,uint64 updatedAt,uint8 status))",
]);

export const organizationRegistryReadAbi = parseAbi([
  "function organizationOfAccount(address account) view returns (bytes32)",
  "function isActiveAccount(address account) view returns (bool)",
]);

export function requireHex32(value: string, label: string): Hex {
  if (!HEX32_PATTERN.test(value)) throw new Error(`${label} is not a canonical bytes32 value.`);
  return value as Hex;
}

export function getOrderNetwork() {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const orderRegistryAddress = process.env.THREADPROOF_ORDER_REGISTRY_ADDRESS ?? process.env.ORDER_REGISTRY_ADDRESS;
  const organizationRegistryAddress = process.env.THREADPROOF_REGISTRY_ADDRESS;
  const configuredChainId = Number(process.env.THREADPROOF_CHAIN_ID ?? process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? "0");

  if (!rpcUrl) throw new Error("THREADPROOF_RPC_URL is not configured.");
  if (!orderRegistryAddress || !/^0x[0-9a-fA-F]{40}$/.test(orderRegistryAddress)) {
    throw new Error("ThreadProof OrderRegistry address is not configured.");
  }
  if (!organizationRegistryAddress || !/^0x[0-9a-fA-F]{40}$/.test(organizationRegistryAddress)) {
    throw new Error("THREADPROOF_REGISTRY_ADDRESS is not configured.");
  }
  if (!Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) {
    throw new Error("THREADPROOF_CHAIN_ID is not configured.");
  }

  return {
    rpcUrl,
    orderRegistryAddress: orderRegistryAddress as Address,
    organizationRegistryAddress: organizationRegistryAddress as Address,
    configuredChainId,
    client: createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) }),
  };
}

export function decodeDataKey() {
  const encoded = process.env.THREADPROOF_DATA_KEY_BASE64;
  if (!encoded) throw new Error("THREADPROOF_DATA_KEY_BASE64 is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("THREADPROOF_DATA_KEY_BASE64 must decode to 32 bytes.");
  return key;
}

export function encryptOrderPayload(payload: { orderWorkload: string; orderRandomness: string }) {
  const key = decodeDataKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = JSON.stringify(payload);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext: `\\x${ciphertext.toString("hex")}`,
    nonce: `\\x${nonce.toString("hex")}`,
  };
}

export function randomFieldElement() {
  return BigInt(`0x${randomBytes(30).toString("hex")}`);
}

export async function computeOrderCommitment(chainOrderId: Hex, workload: bigint, randomness: bigint) {
  const poseidon = await buildPoseidon();
  const orderField = BigInt(chainOrderId) % SNARK_FIELD;
  return BigInt(poseidon.F.toString(poseidon([orderField, workload, randomness, 2n])));
}
