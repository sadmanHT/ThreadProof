import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  bufferToBytea,
  byteaToBuffer,
  decodeDataKey,
  decryptEmbedded,
  encryptEmbedded,
} from "./crypto.js";
import { createServiceClient } from "./supabase.js";

const credentialAbi = parseAbi([
  "function getCredential(bytes32 credentialId) view returns ((bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 issuerOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil,uint8 status))",
  "function isCredentialActive(bytes32 credentialId) view returns (bool)",
  "event CredentialIssued(bytes32 indexed credentialId,bytes32 indexed subjectOrganizationId,bytes32 indexed issuerOrganizationId,bytes32 credentialType,uint64 validFrom,uint64 validUntil,bytes32 digest,bytes32 scopeHash)",
]);

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimal = z.string().regex(/^[0-9]+$/);
const CAPACITY_CREDENTIAL_TYPE = keccak256(toBytes("CAPACITY_CREDENTIAL"));

const anchorSchema = z.object({
  credentialId: hex32,
  subjectOrganizationId: hex32,
  issuerOrganizationId: hex32,
  credentialType: hex32,
  scopeHash: hex32,
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
}).strict();

const presentationSchema = {
  format: z.literal("threadproof-private-credential/v1"),
  "@context": z.array(z.string().min(1)).min(1),
  type: z.array(z.string().min(1)).min(1),
  issuer: z.string().min(1),
  anchor: anchorSchema,
};

const genericCredentialBodySchema = z.object({
  ...presentationSchema,
  digestBinding: z.object({
    method: z.literal("keccak256-canonical-json-v1"),
  }).strict(),
  credentialSubject: z.record(z.string(), z.unknown()),
}).strict();

const capacityCredentialBodySchema = z.object({
  ...presentationSchema,
  digestBinding: z.object({
    method: z.literal("threadproof-capacity-credential-v1"),
    note: z.literal("Canonical digest binds the ThreadProof capacity fields below; presentation fields remain package-integrity protected."),
  }).strict(),
  credentialSubject: z.object({
    factoryOrganizationId: hex32,
    auditorOrganizationId: hex32,
    periodId: hex32,
    processId: hex32,
    policyHash: hex32,
    initialCommitment: decimal,
    scopeHash: hex32,
    methodology: z.string().min(1),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime(),
    circuitVersion: z.number().int().positive().max(4_294_967_295),
  }).strict(),
}).strict();

const privateCredentialBodySchema = z.union([
  genericCredentialBodySchema,
  capacityCredentialBodySchema,
]);

type PrivateCredentialBody = z.infer<typeof privateCredentialBodySchema>;
type CanonicalRecord = Awaited<ReturnType<typeof canonicalRecord>>["record"];

const packageSchema = z.object({
  format: z.literal("threadproof-credential-package/v1"),
  chainId: z.number().int().positive(),
  credentialRegistry: address,
  credentialId: hex32,
  subjectOrganizationId: hex32,
  issuerOrganizationId: hex32,
  credentialType: hex32,
  credentialTypeLabel: z.string().min(1),
  digest: hex32,
  scopeHash: hex32,
  validFrom: z.string().datetime(),
  validUntil: z.string().datetime(),
  status: z.enum(["active", "suspended", "revoked"]),
  currentlyUsable: z.boolean(),
  credentialBody: privateCredentialBodySchema,
  credentialBodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  issuance: z.object({
    transactionHash: hex32,
    blockNumber: decimal,
    blockHash: hex32,
    logIndex: z.number().int().nonnegative(),
  }).strict(),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Credential body contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableCanonical(object[key])}`).join(",")}}`;
  }
  throw new Error(`Credential body contains unsupported JSON value type ${typeof value}.`);
}

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function statusLabel(status: number) {
  if (status === 1) return "active" as const;
  if (status === 2) return "suspended" as const;
  if (status === 3) return "revoked" as const;
  throw new Error(`Unknown canonical credential status ${status}`);
}

function isoFromSeconds(seconds: bigint) {
  const millis = Number(seconds) * 1000;
  if (!Number.isSafeInteger(millis)) throw new Error("Credential validity timestamp exceeds safe JavaScript date range.");
  return new Date(millis).toISOString();
}

function secondsFromIso(value: string) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis % 1000 !== 0) throw new Error(`Credential timestamp ${value} must resolve to whole seconds.`);
  return BigInt(millis / 1000);
}

function packageHashBody(value: unknown) {
  return stableCanonical(value);
}

function assertAnchorMatchesCanonical(body: PrivateCredentialBody, record: CanonicalRecord) {
  const anchor = body.anchor;
  if (
    !sameHex(anchor.credentialId, record.credentialId) ||
    !sameHex(anchor.subjectOrganizationId, record.subjectOrganizationId) ||
    !sameHex(anchor.issuerOrganizationId, record.issuerOrganizationId) ||
    !sameHex(anchor.credentialType, record.credentialType) ||
    !sameHex(anchor.scopeHash, record.scopeHash) ||
    new Date(anchor.validFrom).toISOString() !== isoFromSeconds(record.validFrom) ||
    new Date(anchor.validUntil).toISOString() !== isoFromSeconds(record.validUntil)
  ) {
    throw new Error("Private credential body anchor does not match canonical CredentialRegistry state.");
  }
}

function capacityDigest(body: z.infer<typeof capacityCredentialBodySchema>, record: CanonicalRecord): Hex {
  if (!sameHex(record.credentialType, CAPACITY_CREDENTIAL_TYPE)) {
    throw new Error("threadproof-capacity-credential-v1 can only seal CAPACITY_CREDENTIAL records.");
  }
  const claims = body.credentialSubject;
  if (
    !sameHex(claims.factoryOrganizationId, record.subjectOrganizationId) ||
    !sameHex(claims.auditorOrganizationId, record.issuerOrganizationId) ||
    !sameHex(claims.scopeHash, record.scopeHash) ||
    secondsFromIso(claims.validFrom) !== record.validFrom ||
    secondsFromIso(claims.validUntil) !== record.validUntil
  ) {
    throw new Error("Capacity credential claims do not match canonical subject, issuer, scope or validity.");
  }

  const methodologyHash = keccak256(toBytes(claims.methodology.trim()));
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint32" },
    ],
    [
      record.credentialId,
      record.subjectOrganizationId,
      record.issuerOrganizationId,
      claims.periodId as Hex,
      claims.processId as Hex,
      claims.policyHash as Hex,
      BigInt(claims.initialCommitment),
      record.scopeHash,
      methodologyHash,
      record.validFrom,
      record.validUntil,
      claims.circuitVersion,
    ],
  ));
}

function assertedBodyDigest(body: PrivateCredentialBody, record: CanonicalRecord): Hex {
  assertAnchorMatchesCanonical(body, record);
  const digest = body.digestBinding.method === "threadproof-capacity-credential-v1"
    ? capacityDigest(body, record)
    : keccak256(toBytes(stableCanonical(body)));
  if (!sameHex(digest, record.digest)) {
    throw new Error(`Private credential body digest ${digest} does not match canonical digest ${record.digest}.`);
  }
  return digest;
}

async function canonicalRecord(rpcUrl: string, registry: Address, credentialId: Hex) {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000, retryCount: 2, retryDelay: 250 }) });
  const [chainId, record, active] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: registry, abi: credentialAbi, functionName: "getCredential", args: [credentialId] }),
    client.readContract({ address: registry, abi: credentialAbi, functionName: "isCredentialActive", args: [credentialId] }),
  ]);
  if (record.credentialId === `0x${"0".repeat(64)}`) throw new Error(`Credential ${credentialId} does not exist on CredentialRegistry.`);
  return { client, chainId, record, active };
}

async function canonicalIssuance(
  client: Awaited<ReturnType<typeof canonicalRecord>>["client"],
  registry: Address,
  transactionHash: Hex,
  record: CanonicalRecord,
) {
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error("Credential issuance transaction reverted.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!block.hash || !sameHex(block.hash, receipt.blockHash)) {
    throw new Error("Credential issuance receipt block is no longer canonical.");
  }

  for (const log of receipt.logs) {
    if (!sameHex(log.address, registry)) continue;
    try {
      const decoded = decodeEventLog({ abi: credentialAbi, eventName: "CredentialIssued", data: log.data, topics: log.topics });
      const args = decoded.args;
      if (!sameHex(args.credentialId, record.credentialId)) continue;
      if (
        !sameHex(args.subjectOrganizationId, record.subjectOrganizationId) ||
        !sameHex(args.issuerOrganizationId, record.issuerOrganizationId) ||
        !sameHex(args.credentialType, record.credentialType) ||
        !sameHex(args.digest, record.digest) ||
        !sameHex(args.scopeHash, record.scopeHash) ||
        args.validFrom !== record.validFrom ||
        args.validUntil !== record.validUntil
      ) {
        throw new Error("CredentialIssued event does not match current canonical credential identity fields.");
      }
      return {
        transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        logIndex: Number(log.logIndex),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not match current canonical")) throw error;
    }
  }
  throw new Error(`Transaction ${transactionHash} does not contain the canonical CredentialIssued event for ${record.credentialId}.`);
}

function assertConfiguredChain(configured: number | undefined, actual: number) {
  if (configured !== undefined && configured !== actual) {
    throw new Error(`RPC chain ID ${actual} does not match configured ${configured}.`);
  }
}

async function sealBody(credentialId: Hex, inputPath: string) {
  const env = z.object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    THREADPROOF_RPC_URL: z.string().url(),
    THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
    THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address,
    THREADPROOF_DATA_KEY_BASE64: z.string().min(20),
    THREADPROOF_DATA_KEY_VERSION: z.coerce.number().int().positive().default(1),
  }).parse(process.env);
  const registry = env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS as Address;
  const { chainId, record } = await canonicalRecord(env.THREADPROOF_RPC_URL, registry, credentialId);
  assertConfiguredChain(env.THREADPROOF_CHAIN_ID, chainId);

  const body = privateCredentialBodySchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  assertedBodyDigest(body, record);
  const canonicalBody = stableCanonical(body);
  const bodySha256 = sha256Hex(canonicalBody);
  const dataKey = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);

  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: credential, error: credentialError } = await supabase
    .from("credentials")
    .select("id,digest")
    .eq("chain_credential_id", credentialId)
    .single();
  if (credentialError) throw credentialError;
  if (!sameHex(credential.digest, record.digest)) throw new Error("Credential database mirror digest does not match canonical CredentialRegistry state.");

  const now = new Date().toISOString();
  const { error: sealError } = await supabase.from("credential_private_packages").upsert({
    credential_id: credential.id,
    encrypted_body: bufferToBytea(encryptEmbedded(canonicalBody, dataKey)),
    encryption_key_version: env.THREADPROOF_DATA_KEY_VERSION,
    body_sha256: bodySha256,
    sealed_at: now,
    updated_at: now,
  }, { onConflict: "credential_id" });
  if (sealError) throw sealError;

  console.log(`Sealed private credential body ${credentialId}; sha256=${bodySha256}; digest=${record.digest}`);
}

async function exportPackage(credentialId: Hex, outputPath: string) {
  const env = z.object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    THREADPROOF_RPC_URL: z.string().url(),
    THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
    THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address,
    THREADPROOF_DATA_KEY_BASE64: z.string().min(20),
  }).parse(process.env);
  const registry = env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS as Address;
  const { client, chainId, record, active } = await canonicalRecord(env.THREADPROOF_RPC_URL, registry, credentialId);
  assertConfiguredChain(env.THREADPROOF_CHAIN_ID, chainId);

  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: credential, error: credentialError } = await supabase
    .from("credentials")
    .select("id,chain_tx_hash,credential_type,digest,scope_hash,subject_organization_id,issuer_organization_id")
    .eq("chain_credential_id", credentialId)
    .single();
  if (credentialError) throw credentialError;
  if (!credential.chain_tx_hash) {
    throw new Error("Credential mirror predates canonical issuance provenance. Re-index CredentialIssued before exporting a portable package.");
  }

  const [{ data: subject, error: subjectError }, { data: issuer, error: issuerError }, { data: privatePackage, error: privateError }] = await Promise.all([
    supabase.from("organizations").select("chain_organization_id").eq("id", credential.subject_organization_id).single(),
    supabase.from("organizations").select("chain_organization_id").eq("id", credential.issuer_organization_id).single(),
    supabase.from("credential_private_packages").select("encrypted_body,encryption_key_version,body_sha256").eq("credential_id", credential.id).single(),
  ]);
  if (subjectError) throw subjectError;
  if (issuerError) throw issuerError;
  if (privateError) throw new Error(`No sealed private credential body exists for ${credentialId}: ${privateError.message}`);

  if (
    !sameHex(record.credentialId, credentialId) ||
    !sameHex(record.subjectOrganizationId, subject.chain_organization_id) ||
    !sameHex(record.issuerOrganizationId, issuer.chain_organization_id) ||
    !sameHex(record.digest, credential.digest) ||
    !sameHex(record.scopeHash, credential.scope_hash)
  ) throw new Error("Credential database mirror does not match canonical CredentialRegistry state.");

  const canonicalBody = decryptEmbedded(byteaToBuffer(privatePackage.encrypted_body), decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64));
  const credentialBody = privateCredentialBodySchema.parse(JSON.parse(canonicalBody));
  if (sha256Hex(stableCanonical(credentialBody)) !== privatePackage.body_sha256) {
    throw new Error("Sealed private credential body integrity hash is invalid.");
  }
  assertedBodyDigest(credentialBody, record);

  const issuance = await canonicalIssuance(client, registry, credential.chain_tx_hash as Hex, record);
  const body = {
    format: "threadproof-credential-package/v1" as const,
    chainId,
    credentialRegistry: registry,
    credentialId,
    subjectOrganizationId: record.subjectOrganizationId,
    issuerOrganizationId: record.issuerOrganizationId,
    credentialType: record.credentialType,
    credentialTypeLabel: credential.credential_type,
    digest: record.digest,
    scopeHash: record.scopeHash,
    validFrom: isoFromSeconds(record.validFrom),
    validUntil: isoFromSeconds(record.validUntil),
    status: statusLabel(Number(record.status)),
    currentlyUsable: active,
    credentialBody,
    credentialBodySha256: privatePackage.body_sha256,
    issuance,
  };
  const packageSha256 = sha256Hex(packageHashBody(body));
  const output = `${JSON.stringify({ ...body, packageSha256 }, null, 2)}\n`;
  await writeFile(outputPath, output, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(`Exported chain-verifiable ThreadProof credential package ${credentialId} (${packageSha256}) to ${outputPath}`);
}

async function verifyPackage(inputPath: string) {
  const env = z.object({
    THREADPROOF_RPC_URL: z.string().url(),
    THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
  }).parse(process.env);
  const parsed = packageSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const { packageSha256, ...body } = parsed;
  if (sha256Hex(packageHashBody(body)) !== packageSha256) throw new Error("Credential package hash is invalid.");
  if (sha256Hex(stableCanonical(parsed.credentialBody)) !== parsed.credentialBodySha256) {
    throw new Error("Credential body SHA-256 does not match the portable package.");
  }

  const { client, chainId, record, active } = await canonicalRecord(
    env.THREADPROOF_RPC_URL,
    parsed.credentialRegistry as Address,
    parsed.credentialId as Hex,
  );
  assertConfiguredChain(env.THREADPROOF_CHAIN_ID, chainId);
  if (chainId !== parsed.chainId) throw new Error("Credential package chain id does not match canonical RPC.");
  if (
    !sameHex(record.credentialId, parsed.credentialId) ||
    !sameHex(record.subjectOrganizationId, parsed.subjectOrganizationId) ||
    !sameHex(record.issuerOrganizationId, parsed.issuerOrganizationId) ||
    !sameHex(record.credentialType, parsed.credentialType) ||
    !sameHex(record.digest, parsed.digest) ||
    !sameHex(record.scopeHash, parsed.scopeHash) ||
    isoFromSeconds(record.validFrom) !== parsed.validFrom ||
    isoFromSeconds(record.validUntil) !== parsed.validUntil ||
    statusLabel(Number(record.status)) !== parsed.status ||
    active !== parsed.currentlyUsable
  ) throw new Error("Credential package no longer matches canonical CredentialRegistry state.");

  assertedBodyDigest(parsed.credentialBody, record);
  const issuance = await canonicalIssuance(
    client,
    parsed.credentialRegistry as Address,
    parsed.issuance.transactionHash as Hex,
    record,
  );
  if (
    issuance.blockNumber !== parsed.issuance.blockNumber ||
    !sameHex(issuance.blockHash, parsed.issuance.blockHash) ||
    issuance.logIndex !== parsed.issuance.logIndex
  ) throw new Error("Credential package issuance evidence does not match canonical transaction receipt.");

  console.log(`Verified ThreadProof credential package ${parsed.credentialId} against chain ${chainId}; package hash ${packageSha256}`);
}

const [command, arg1, arg2] = process.argv.slice(2);
if (command === "seal" && arg1 && arg2) {
  await sealBody(hex32.parse(arg1) as Hex, arg2);
} else if (command === "export" && arg1 && arg2) {
  await exportPackage(hex32.parse(arg1) as Hex, arg2);
} else if (command === "verify" && arg1) {
  await verifyPackage(arg1);
} else {
  throw new Error("Usage: credential-package.ts seal <credentialId> <body.json> | export <credentialId> <output.json> | verify <package.json>");
}
