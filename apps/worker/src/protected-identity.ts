import { readFile } from "node:fs/promises";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { z } from "zod";
import { bufferToBytea, decodeDataKey, encryptDetached } from "./crypto.js";
import { createServiceClient } from "./supabase.js";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uuid = z.string().uuid();
const sealInputSchema = z.object({
  pseudonym: z.string().trim().min(1).max(200),
  organizationId: uuid,
  disclosurePolicyHash: hex32,
  keyVersion: z.number().int().positive(),
  identity: z.unknown().refine((value) => value !== null && typeof value === "object", {
    message: "identity must be a JSON object or array",
  }),
});

const charterAbi = parseAbi([
  "function hashProtectedIdentityDisclosureAction(bytes32 subjectReference,bytes32 evidenceHash) pure returns (bytes32)",
  "function getProposal(bytes32 proposalId) view returns ((bytes32 id,uint8 proposalType,bytes32 proposerOrganizationId,bytes32 actionHash,bytes32 metadataHash,uint64 policyVersion,uint64 createdAt,uint64 expiresAt,uint64 approvedAt,uint64 executeAfter,uint8 approvalsReceived,uint8 approvalsRequired,uint8 eligibleMask,uint8 requiredMask,uint8 approvalMask,uint64 timelockSeconds,bool executed,bool cancelled))",
]);

const baseEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

function canonicalJson(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

async function sealIdentity(inputPath: string) {
  const env = baseEnvSchema.extend({ THREADPROOF_DATA_KEY_BASE64: z.string().min(20) }).parse(process.env);
  const input = sealInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization) throw new Error("Protected identity organization does not exist.");

  const key = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);
  const encrypted = encryptDetached(canonicalJson(input.identity), key);
  const { data, error } = await supabase
    .from("encrypted_supplier_identities")
    .insert({
      pseudonym: input.pseudonym,
      organization_id: input.organizationId,
      ciphertext: bufferToBytea(encrypted.ciphertext),
      nonce: bufferToBytea(encrypted.nonce),
      key_version: input.keyVersion,
      disclosure_policy_hash: input.disclosurePolicyHash,
    })
    .select("id,pseudonym,organization_id,key_version,disclosure_policy_hash,created_at")
    .single();
  if (error) throw error;

  console.log(JSON.stringify({
    sealed: true,
    identityId: data.id,
    pseudonym: data.pseudonym,
    organizationId: data.organization_id,
    keyVersion: data.key_version,
    disclosurePolicyHash: data.disclosure_policy_hash,
    createdAt: data.created_at,
  }, null, 2));
}

async function stageDisclosure(
  encryptedIdentityId: string,
  proposalId: Hex,
  subjectReference: Hex,
  evidenceHash: Hex,
) {
  const env = baseEnvSchema.extend({
    THREADPROOF_RPC_URL: z.string().url(),
    THREADPROOF_CHAIN_ID: z.coerce.number().int().positive().optional(),
    THREADPROOF_CHARTER_ADDRESS: address,
  }).parse(process.env);
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const client = createPublicClient({ transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }) });
  const charterAddress = env.THREADPROOF_CHARTER_ADDRESS as Address;
  const chainId = await client.getChainId();
  if (env.THREADPROOF_CHAIN_ID && chainId !== env.THREADPROOF_CHAIN_ID) {
    throw new Error(`RPC chain ID ${chainId} does not match configured ${env.THREADPROOF_CHAIN_ID}.`);
  }

  const [proposal, expectedActionHash] = await Promise.all([
    client.readContract({ address: charterAddress, abi: charterAbi, functionName: "getProposal", args: [proposalId] }),
    client.readContract({
      address: charterAddress,
      abi: charterAbi,
      functionName: "hashProtectedIdentityDisclosureAction",
      args: [subjectReference, evidenceHash],
    }),
  ]);
  if (Number(proposal.proposalType) !== 4) throw new Error("Charter proposal is not a ProtectedIdentityDisclosure action.");
  if (proposal.actionHash.toLowerCase() !== expectedActionHash.toLowerCase()) {
    throw new Error("Charter proposal action hash does not bind the supplied subject reference and evidence hash.");
  }
  if (proposal.cancelled) throw new Error("Cancelled Charter proposal cannot stage a disclosure package.");

  const { data: identity, error: identityError } = await supabase
    .from("encrypted_supplier_identities")
    .select("id,disclosure_policy_hash")
    .eq("id", encryptedIdentityId)
    .maybeSingle();
  if (identityError) throw identityError;
  if (!identity) throw new Error("Encrypted protected identity does not exist.");
  if (identity.disclosure_policy_hash.toLowerCase() !== evidenceHash.toLowerCase()) {
    throw new Error("Encrypted identity disclosure policy hash does not match the governed evidence hash.");
  }

  const { data, error } = await supabase
    .from("protected_identity_disclosures")
    .insert({
      encrypted_supplier_identity_id: encryptedIdentityId,
      chain_proposal_id: proposalId,
      subject_reference: subjectReference,
      evidence_hash: evidenceHash,
      action_hash: expectedActionHash,
      status: "staged",
    })
    .select("id,chain_proposal_id,subject_reference,evidence_hash,action_hash,status,created_at")
    .single();
  if (error) throw error;

  console.log(JSON.stringify({
    staged: true,
    disclosureId: data.id,
    chainId,
    charter: charterAddress,
    proposalId: data.chain_proposal_id,
    subjectReference: data.subject_reference,
    evidenceHash: data.evidence_hash,
    actionHash: data.action_hash,
    status: data.status,
    createdAt: data.created_at,
  }, null, 2));
}

const [command, ...args] = process.argv.slice(2);
if (command === "seal" && args.length === 1) {
  await sealIdentity(args[0]!);
} else if (command === "stage" && args.length === 4) {
  await stageDisclosure(uuid.parse(args[0]), hex32.parse(args[1]) as Hex, hex32.parse(args[2]) as Hex, hex32.parse(args[3]) as Hex);
} else {
  throw new Error(
    "Usage: protected-identity.ts seal <identity-input.json> | stage <encryptedIdentityId> <proposalId> <subjectReference> <evidenceHash>",
  );
}
