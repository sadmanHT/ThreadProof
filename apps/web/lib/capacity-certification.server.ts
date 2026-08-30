import "server-only";

import { createCipheriv, randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const CAPACITY_UINT64_MAX = (1n << 64n) - 1n;
export const CAPACITY_CREDENTIAL_TYPE = keccak256(toBytes("CAPACITY_CREDENTIAL"));
export const ISSUER_ROLE = keccak256(toBytes("ISSUER_ROLE"));
export const CERTIFIER_ROLE = keccak256(toBytes("CERTIFIER_ROLE"));
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const organizationRegistryCertificationAbi = parseAbi([
  "function organizationOfAccount(address account) view returns (bytes32)",
  "function isActiveAccount(address account) view returns (bool)",
]);

export const credentialRegistryCertificationAbi = parseAbi([
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function isCredentialActive(bytes32 credentialId) view returns (bool)",
  "function getCredential(bytes32 credentialId) view returns ((bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 issuerOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil,uint8 status))",
]);

export const capacityVaultCertificationAbi = parseAbi([
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function verifiers(uint32 circuitVersion) view returns (address)",
]);

function requireAddress(value: string | undefined, label: string): Address {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} is not configured.`);
  return value as Address;
}

export function requireCapacityHex32(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a canonical bytes32 value.`);
  return value as Hex;
}

export function getCapacityCertificationNetwork() {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  if (!rpcUrl) throw new Error("THREADPROOF_RPC_URL is not configured.");
  const configuredChainId = Number(process.env.THREADPROOF_CHAIN_ID ?? process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? "0");
  if (!Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) {
    throw new Error("THREADPROOF_CHAIN_ID is not configured.");
  }
  return {
    client: createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) }),
    configuredChainId,
    organizationRegistryAddress: requireAddress(process.env.THREADPROOF_REGISTRY_ADDRESS, "ThreadProofRegistry address"),
    credentialRegistryAddress: requireAddress(process.env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS, "CredentialRegistry address"),
    capacityVaultAddress: requireAddress(process.env.THREADPROOF_CAPACITY_VAULT_ADDRESS, "CapacityVault address"),
  };
}

function decodeDataKey() {
  const encoded = process.env.THREADPROOF_DATA_KEY_BASE64;
  if (!encoded) throw new Error("THREADPROOF_DATA_KEY_BASE64 is not configured.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("THREADPROOF_DATA_KEY_BASE64 must decode to exactly 32 bytes.");
  return key;
}

export function encryptCapacityScalar(value: bigint) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeDataKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value.toString(), "utf8"), cipher.final()]);
  const envelope = Buffer.concat([Buffer.from([1]), nonce, ciphertext, cipher.getAuthTag()]);
  return `\\x${envelope.toString("hex")}`;
}

export function randomCapacityFieldElement() {
  return BigInt(`0x${randomBytes(30).toString("hex")}`);
}

export function randomCredentialId(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function semanticCapacityId(domain: "period" | "process", label: string): Hex {
  return keccak256(toBytes(`threadproof:${domain}:${normalizeLabel(label)}`));
}

function field(value: Hex) {
  return BigInt(value) % SNARK_FIELD;
}

export async function computeInitialCapacityCommitment(
  factoryOrganizationId: Hex,
  periodId: Hex,
  processId: Hex,
  policyHash: Hex,
  capacity: bigint,
  randomness: bigint,
) {
  const poseidon = await buildPoseidon();
  return BigInt(poseidon.F.toString(poseidon([
    field(factoryOrganizationId),
    field(periodId),
    field(processId),
    field(policyHash),
    capacity,
    randomness,
    1n,
  ])));
}

export function computeCapacityScopeHash(
  factoryOrganizationId: Hex,
  periodId: Hex,
  processId: Hex,
  policyHash: Hex,
  initialCommitment: bigint,
) {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
    ],
    [factoryOrganizationId, periodId, processId, policyHash, initialCommitment],
  ));
}

export function computeCapacityStateKey(factoryOrganizationId: Hex, periodId: Hex, processId: Hex) {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [factoryOrganizationId, periodId, processId],
  ));
}

export function computeCapacityCredentialDigest(input: {
  credentialId: Hex;
  factoryOrganizationId: Hex;
  auditorOrganizationId: Hex;
  periodId: Hex;
  processId: Hex;
  policyHash: Hex;
  initialCommitment: bigint;
  scopeHash: Hex;
  methodology: string;
  validFrom: bigint;
  validUntil: bigint;
  circuitVersion: number;
}) {
  const methodologyHash = keccak256(toBytes(input.methodology.trim()));
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint32" },
    ],
    [
      input.credentialId,
      input.factoryOrganizationId,
      input.auditorOrganizationId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.initialCommitment,
      input.scopeHash,
      methodologyHash,
      input.validFrom,
      input.validUntil,
      input.circuitVersion,
    ],
  ));
}
