import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { byteaToBuffer, decodeDataKey, decryptDetached } from "./crypto.js";
import { createServiceClient } from "./supabase.js";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  THREADPROOF_DATA_KEY_BASE64: z.string().min(20),
  THREADPROOF_DISCLOSURE_ID: z.string().uuid(),
  THREADPROOF_DISCLOSURE_RECIPIENT_PUBLIC_KEY_PATH: z.string().min(1),
  THREADPROOF_DISCLOSURE_OUTPUT_PATH: z.string().min(1),
});

function sha256Hex(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const env = envSchema.parse(process.env);
  const supabase = createServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const dataKey = decodeDataKey(env.THREADPROOF_DATA_KEY_BASE64);

  const { data: disclosure, error: disclosureError } = await supabase
    .from("protected_identity_disclosures")
    .select("*")
    .eq("id", env.THREADPROOF_DISCLOSURE_ID)
    .single();
  if (disclosureError) throw disclosureError;
  if (!disclosure || !["authorized", "released"].includes(disclosure.status)) {
    throw new Error("Disclosure package is not canonically authorized.");
  }
  if (!disclosure.authorized_tx_hash || disclosure.authorized_block_number == null) {
    throw new Error("Authorized disclosure is missing canonical transaction evidence.");
  }

  const { data: canonicalEvent, error: eventError } = await supabase
    .from("chain_events")
    .select("transaction_hash,block_number,data")
    .eq("event_name", "ProtectedIdentityDisclosureAuthorized")
    .eq("transaction_hash", disclosure.authorized_tx_hash)
    .eq("block_number", disclosure.authorized_block_number)
    .maybeSingle();
  if (eventError) throw eventError;
  const eventData = canonicalEvent?.data as Record<string, unknown> | undefined;
  if (
    !canonicalEvent ||
    String(eventData?.proposalId ?? "").toLowerCase() !== disclosure.chain_proposal_id.toLowerCase() ||
    String(eventData?.subjectReference ?? "").toLowerCase() !== disclosure.subject_reference.toLowerCase() ||
    String(eventData?.evidenceHash ?? "").toLowerCase() !== disclosure.evidence_hash.toLowerCase()
  ) {
    throw new Error("Canonical disclosure event no longer matches the authorized disclosure receipt.");
  }

  const { data: identity, error: identityError } = await supabase
    .from("encrypted_supplier_identities")
    .select("id,pseudonym,organization_id,ciphertext,nonce,key_version,disclosure_policy_hash")
    .eq("id", disclosure.encrypted_supplier_identity_id)
    .single();
  if (identityError) throw identityError;
  if (identity.disclosure_policy_hash.toLowerCase() !== disclosure.evidence_hash.toLowerCase()) {
    throw new Error("Supplier identity disclosure policy/evidence hash does not match the authorized evidence hash.");
  }

  const plaintext = decryptDetached(byteaToBuffer(identity.ciphertext), byteaToBuffer(identity.nonce), dataKey);
  const recipientPem = await readFile(env.THREADPROOF_DISCLOSURE_RECIPIENT_PUBLIC_KEY_PATH);
  const recipientKey = createPublicKey(recipientPem);
  if (recipientKey.asymmetricKeyType !== "rsa" && recipientKey.asymmetricKeyType !== "rsa-pss") {
    throw new Error("Due-process disclosure recipient key must be RSA/RSA-PSS for RSA-OAEP envelope encryption.");
  }
  const recipientSpki = recipientKey.export({ type: "spki", format: "der" }) as Buffer;
  const recipientKeyFingerprint = sha256Hex(recipientSpki);

  const packageKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", packageKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key: recipientKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, packageKey);

  const packageBody = {
    format: "threadproof-protected-identity-disclosure/v1",
    chainProposalId: disclosure.chain_proposal_id,
    subjectReference: disclosure.subject_reference,
    evidenceHash: disclosure.evidence_hash,
    actionHash: disclosure.action_hash,
    authorization: {
      transactionHash: disclosure.authorized_tx_hash,
      blockNumber: String(disclosure.authorized_block_number),
      authorizedAt: disclosure.authorized_at,
    },
    identityReference: {
      pseudonym: identity.pseudonym,
      organizationId: identity.organization_id,
      keyVersion: identity.key_version,
    },
    recipientKeyFingerprint,
    encryption: {
      algorithm: "AES-256-GCM+RSA-OAEP-SHA256",
      wrappedKeyBase64: wrappedKey.toString("base64"),
      nonceBase64: nonce.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      authTagBase64: tag.toString("base64"),
    },
  };
  const serialized = `${JSON.stringify(packageBody, null, 2)}\n`;
  const packageSha256 = sha256Hex(serialized);
  const output = `${JSON.stringify({ ...packageBody, packageSha256 }, null, 2)}\n`;

  await writeFile(env.THREADPROOF_DISCLOSURE_OUTPUT_PATH, output, { mode: 0o600 });
  await chmod(env.THREADPROOF_DISCLOSURE_OUTPUT_PATH, 0o600);

  const { error: updateError } = await supabase.from("protected_identity_disclosures").update({
    status: "released",
    released_at: new Date().toISOString(),
    recipient_key_fingerprint: recipientKeyFingerprint,
    package_sha256: packageSha256,
    error_code: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
  }).eq("id", disclosure.id).in("status", ["authorized", "released"]);
  if (updateError) throw updateError;

  console.log(`Wrote sealed due-process disclosure package ${packageSha256} to ${env.THREADPROOF_DISCLOSURE_OUTPUT_PATH}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
