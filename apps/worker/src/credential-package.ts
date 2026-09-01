import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";
import { createServiceClient } from "./supabase.js";

const credentialAbi = parseAbi([
  "function getCredential(bytes32 credentialId) view returns ((bytes32 credentialId,bytes32 subjectOrganizationId,bytes32 issuerOrganizationId,bytes32 credentialType,bytes32 digest,bytes32 scopeHash,uint64 validFrom,uint64 validUntil,uint8 status))",
  "function isCredentialActive(bytes32 credentialId) view returns (bool)",
]);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
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
  issuance: z.object({ transactionHash: hex32, blockNumber: z.string().regex(/^[0-9]+$/) }),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function statusLabel(status: number) {
  if (status === 1) return "active" as const;
  if (status === 2) return "suspended" as const;
  if (status === 3) return "revoked" as const;
  throw new Error(`Unknown canonical credential status ${status}`);
}

function isoFromSeconds(seconds: bigint) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function packageHashBody(value: Omit<z.infer<typeof packageSchema>, "packageSha256">) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function canonicalRecord(rpcUrl: string, registry: Address, credentialId: Hex) {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) });
  const [chainId, record, active] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: registry, abi: credentialAbi, functionName: "getCredential", args: [credentialId] }),
    client.readContract({ address: registry, abi: credentialAbi, functionName: "isCredentialActive", args: [credentialId] }),
  ]);
  return { client, chainId, record, active };
}

async function exportPackage(credentialId: Hex, outputPath: string) {
  const env = z.object({
    SUPABASE_URL: z.string().url(), SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    THREADPROOF_RPC_URL: z.string().url(), THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
    THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS: address,
  }).parse(process.env);
  const registry = env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS as Address;
  const { chainId, record, active } = await canonicalRecord(env.THREADPROOF_RPC_URL, registry, credentialId);
  if (env.THREADPROOF_CHAIN_ID && env.THREADPROOF_CHAIN_ID !== chainId) throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}`);

  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: credential, error: credentialError } = await supabase.from("credentials").select("*").eq("chain_credential_id", credentialId).single();
  if (credentialError) throw credentialError;
  const [{ data: subject, error: subjectError }, { data: issuer, error: issuerError }] = await Promise.all([
    supabase.from("organizations").select("chain_organization_id").eq("id", credential.subject_organization_id).single(),
    supabase.from("organizations").select("chain_organization_id").eq("id", credential.issuer_organization_id).single(),
  ]);
  if (subjectError) throw subjectError;
  if (issuerError) throw issuerError;

  if (
    record.credentialId.toLowerCase() !== credentialId.toLowerCase() ||
    record.subjectOrganizationId.toLowerCase() !== subject.chain_organization_id.toLowerCase() ||
    record.issuerOrganizationId.toLowerCase() !== issuer.chain_organization_id.toLowerCase() ||
    record.digest.toLowerCase() !== credential.digest.toLowerCase() ||
    record.scopeHash.toLowerCase() !== credential.scope_hash.toLowerCase()
  ) throw new Error("Credential database mirror does not match the canonical CredentialRegistry record.");

  const { data: issueEvent, error: eventError } = await supabase.from("chain_events")
    .select("transaction_hash,block_number,data").eq("event_name", "CredentialIssued")
    .eq("transaction_hash", credential.chain_tx_hash).order("log_index", { ascending: true }).limit(1).maybeSingle();
  if (eventError) throw eventError;
  if (!issueEvent || String((issueEvent.data as Record<string, unknown>)?.credentialId ?? "").toLowerCase() !== credentialId.toLowerCase()) {
    throw new Error("Credential issuance transaction is not backed by a matching canonical CredentialIssued event.");
  }

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
    issuance: { transactionHash: issueEvent.transaction_hash as Hex, blockNumber: String(issueEvent.block_number) },
  };
  const packageSha256 = sha256Hex(packageHashBody(body));
  const output = `${JSON.stringify({ ...body, packageSha256 }, null, 2)}\n`;
  await writeFile(outputPath, output, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(`Exported ThreadProof credential package ${credentialId} (${packageSha256}) to ${outputPath}`);
}

async function verifyPackage(inputPath: string) {
  const env = z.object({ THREADPROOF_RPC_URL: z.string().url(), THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional() }).parse(process.env);
  const parsed = packageSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const { packageSha256, ...body } = parsed;
  if (sha256Hex(packageHashBody(body)) !== packageSha256) throw new Error("Credential package hash is invalid.");

  const { chainId, record, active } = await canonicalRecord(env.THREADPROOF_RPC_URL, parsed.credentialRegistry as Address, parsed.credentialId as Hex);
  if (chainId !== parsed.chainId || (env.THREADPROOF_CHAIN_ID && chainId !== env.THREADPROOF_CHAIN_ID)) throw new Error("Credential package chain id does not match the canonical RPC.");
  if (
    record.credentialId.toLowerCase() !== parsed.credentialId.toLowerCase() ||
    record.subjectOrganizationId.toLowerCase() !== parsed.subjectOrganizationId.toLowerCase() ||
    record.issuerOrganizationId.toLowerCase() !== parsed.issuerOrganizationId.toLowerCase() ||
    record.credentialType.toLowerCase() !== parsed.credentialType.toLowerCase() ||
    record.digest.toLowerCase() !== parsed.digest.toLowerCase() ||
    record.scopeHash.toLowerCase() !== parsed.scopeHash.toLowerCase() ||
    isoFromSeconds(record.validFrom) !== parsed.validFrom ||
    isoFromSeconds(record.validUntil) !== parsed.validUntil ||
    statusLabel(Number(record.status)) !== parsed.status ||
    active !== parsed.currentlyUsable
  ) throw new Error("Credential package no longer matches canonical CredentialRegistry state.");

  console.log(`Verified ThreadProof credential package ${parsed.credentialId} against chain ${chainId}; package hash ${packageSha256}`);
}

const [command, arg1, arg2] = process.argv.slice(2);
if (command === "export" && arg1 && arg2) {
  await exportPackage(hex32.parse(arg1) as Hex, arg2);
} else if (command === "verify" && arg1) {
  await verifyPackage(arg1);
} else {
  throw new Error("Usage: credential-package.ts export <credentialId> <output.json> | verify <package.json>");
}
