#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(
  process.cwd(),
  process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json",
);

function fail(message) {
  console.error(`Production release readiness failed: ${message}`);
  process.exit(1);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PROJECT_REF = /^[a-z0-9]{12,40}$/;
const FORBIDDEN_TEXT = /(todo|tbd|placeholder|replace[-_ ]?me|example|dummy|changeme)/i;
const SECRET_KEY_FRAGMENTS = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "password",
  "passwd",
  "privatekey",
  "secretkey",
  "secretaccesskey",
  "servicerolekey",
  "mnemonic",
  "seedphrase",
  "authorization",
  "authheader",
  "signercredential",
  "credentialsecret",
];
const SAFE_SECRET_LIKE_KEYS = new Set(["supabaseLeakedPasswordProtectionVerified"]);

function cleanText(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  requireValue(!FORBIDDEN_TEXT.test(value), `${label} still contains placeholder text.`);
  return value.trim();
}

function hash32(value, label) {
  requireValue(typeof value === "string" && HEX_32.test(value), `${label} must be a 32-byte 0x-prefixed hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be the zero hash.`);
  return value;
}

function address(value, label) {
  requireValue(typeof value === "string" && HEX_20.test(value), `${label} must be a canonical EVM address.`);
  requireValue(!/^0x0{40}$/i.test(value), `${label} must not be the zero address.`);
  return value.toLowerCase();
}

function sha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 hex digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
}

function isoDate(value, label) {
  const text = cleanText(value, label);
  const parsed = Date.parse(text);
  requireValue(Number.isFinite(parsed), `${label} must be an ISO-8601 timestamp.`);
  return parsed;
}

function httpsUrl(value, label) {
  const text = cleanText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid URL.`);
  }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  requireValue(!url.username && !url.password, `${label} must not contain URL credentials.`);
  return text;
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecretMaterial(value, label = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizeKey(key);
      requireValue(
        SAFE_SECRET_LIKE_KEYS.has(key) || !SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment)),
        `${label}.${key} uses a secret-bearing field name.`,
      );
      assertNoSecretMaterial(entry, `${label}.${key}`);
    }
    return;
  }
  if (typeof value !== "string" || !value.includes("://")) return;
  try {
    const url = new URL(value);
    requireValue(!url.username && !url.password, `${label} contains a credential-bearing URL.`);
  } catch {
    // Non-URL text containing :// is validated by its owning field when applicable.
  }
}

function assertExactKeys(record, allowedKeys, label) {
  requireValue(isRecord(record), `${label} must be an object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    requireValue(allowed.has(key), `${label} contains unexpected field ${key}.`);
  }
}

if (!existsSync(manifestPath)) {
  fail(`missing ${path.relative(process.cwd(), manifestPath)}. Copy release/production-release.example.json only after replacing every placeholder with verified production evidence.`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`release manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

requireValue(isRecord(manifest), "release manifest must be a JSON object.");
assertNoSecretMaterial(manifest);
assertExactKeys(
  manifest,
  ["schemaVersion", "release", "chain", "contracts", "verifiers", "signing", "evidence", "externalControls", "approval"],
  "release manifest",
);
requireValue(manifest.schemaVersion === 1, "schemaVersion must equal 1.");

const release = manifest.release;
assertExactKeys(release, ["version", "sourceDevelopCommit", "preparedAt", "preparedBy"], "release");
const releaseVersion = cleanText(release.version, "release.version");
requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
requireValue(typeof release.sourceDevelopCommit === "string" && GIT_SHA.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must be a full 40-character Git SHA.");
requireValue(!/^0{40}$/i.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must not be the zero SHA.");
const preparedAt = isoDate(release.preparedAt, "release.preparedAt");
cleanText(release.preparedBy, "release.preparedBy");

const chain = manifest.chain;
assertExactKeys(chain, ["networkName", "chainId", "genesisHash", "validatorCount"], "chain");
requireValue(chain.chainId === 2026, "chain.chainId must equal the ThreadProof chain ID 2026.");
hash32(chain.genesisHash, "chain.genesisHash");
requireValue(Number.isInteger(chain.validatorCount) && chain.validatorCount >= 5, "chain.validatorCount must be at least 5.");
cleanText(chain.networkName, "chain.networkName");

const requiredContracts = [
  "Registry",
  "CredentialRegistry",
  "OrderRegistry",
  "CapacityVault",
  "SubcontractGovernor",
  "ThreadProofCharter",
];
const contracts = manifest.contracts;
requireValue(Array.isArray(contracts), "contracts must be an array.");
requireValue(contracts.length === requiredContracts.length, "contracts must contain exactly the six canonical ThreadProof state contracts.");
const byName = new Map();
const contractAddresses = new Set();
for (const entry of contracts) {
  assertExactKeys(entry, ["name", "address", "runtimeCodeHash"], "contracts[]");
  const name = cleanText(entry.name, "contracts[].name");
  requireValue(!byName.has(name), `contract ${name} is duplicated.`);
  const normalizedAddress = address(entry.address, `contract ${name} address`);
  requireValue(!contractAddresses.has(normalizedAddress), `contract address ${normalizedAddress} is reused.`);
  hash32(entry.runtimeCodeHash, `contract ${name} runtimeCodeHash`);
  byName.set(name, entry);
  contractAddresses.add(normalizedAddress);
}
for (const required of requiredContracts) {
  requireValue(byName.has(required), `required contract ${required} is missing.`);
}

const verifiers = manifest.verifiers;
assertExactKeys(verifiers, ["capacitySpend", "capacityRelease"], "verifiers");
const verifierAddresses = new Set();
for (const key of ["capacitySpend", "capacityRelease"]) {
  const verifier = verifiers[key];
  assertExactKeys(
    verifier,
    [
      "circuitVersion",
      "address",
      "circuitArtifactHash",
      "verificationKeyHash",
      "runtimeCodeHash",
      "buildAttestationSha256",
      "setup",
      "ceremonyEvidenceUrl",
      "ceremonyEvidenceSha256",
    ],
    `verifiers.${key}`,
  );
  requireValue(Number.isInteger(verifier.circuitVersion) && verifier.circuitVersion >= 1, `verifiers.${key}.circuitVersion must be a positive integer.`);
  const normalizedVerifierAddress = address(verifier.address, `verifiers.${key}.address`);
  requireValue(!contractAddresses.has(normalizedVerifierAddress), `verifiers.${key}.address must be distinct from all state-contract addresses.`);
  requireValue(!verifierAddresses.has(normalizedVerifierAddress), `verifiers.${key}.address must be distinct from the other verifier address.`);
  verifierAddresses.add(normalizedVerifierAddress);
  hash32(verifier.circuitArtifactHash, `verifiers.${key}.circuitArtifactHash`);
  hash32(verifier.verificationKeyHash, `verifiers.${key}.verificationKeyHash`);
  hash32(verifier.runtimeCodeHash, `verifiers.${key}.runtimeCodeHash`);
  hash32(verifier.buildAttestationSha256, `verifiers.${key}.buildAttestationSha256`);
  requireValue(verifier.setup === "production-ceremony", `verifiers.${key}.setup must equal production-ceremony.`);
  httpsUrl(verifier.ceremonyEvidenceUrl, `verifiers.${key}.ceremonyEvidenceUrl`);
  hash32(verifier.ceremonyEvidenceSha256, `verifiers.${key}.ceremonyEvidenceSha256`);
}

const signing = manifest.signing;
assertExactKeys(signing, ["mode", "kmsOrHsmBacked", "keyCustodyDescription"], "signing");
requireValue(signing.mode === "remote-web3signer", "signing.mode must equal remote-web3signer for production.");
requireValue(signing.kmsOrHsmBacked === true, "signing.kmsOrHsmBacked must be true.");
cleanText(signing.keyCustodyDescription, "signing.keyCustodyDescription");

const evidence = manifest.evidence;
assertExactKeys(
  evidence,
  [
    "cleanStateRunUrl",
    "qbftFaultRunUrl",
    "qbftFaultEvidenceSha256",
    "benchmarkBundleSha256",
    "benchmarkBundleUrl",
    "deploymentEvidenceUrl",
    "deploymentManifestSha256",
    "uatAdversarialEvidenceUrl",
    "uatAdversarialEvidenceSha256",
    "backupRecoveryEvidenceUrl",
    "backupRecoveryEvidenceSha256",
    "platformControlsEvidenceUrl",
    "platformControlsEvidenceSha256",
  ],
  "evidence",
);
httpsUrl(evidence.cleanStateRunUrl, "evidence.cleanStateRunUrl");
httpsUrl(evidence.qbftFaultRunUrl, "evidence.qbftFaultRunUrl");
sha256(evidence.qbftFaultEvidenceSha256, "evidence.qbftFaultEvidenceSha256");
sha256(evidence.benchmarkBundleSha256, "evidence.benchmarkBundleSha256");
httpsUrl(evidence.benchmarkBundleUrl, "evidence.benchmarkBundleUrl");
httpsUrl(evidence.deploymentEvidenceUrl, "evidence.deploymentEvidenceUrl");
sha256(evidence.deploymentManifestSha256, "evidence.deploymentManifestSha256");
httpsUrl(evidence.uatAdversarialEvidenceUrl, "evidence.uatAdversarialEvidenceUrl");
sha256(evidence.uatAdversarialEvidenceSha256, "evidence.uatAdversarialEvidenceSha256");
httpsUrl(evidence.backupRecoveryEvidenceUrl, "evidence.backupRecoveryEvidenceUrl");
sha256(evidence.backupRecoveryEvidenceSha256, "evidence.backupRecoveryEvidenceSha256");
httpsUrl(evidence.platformControlsEvidenceUrl, "evidence.platformControlsEvidenceUrl");
sha256(evidence.platformControlsEvidenceSha256, "evidence.platformControlsEvidenceSha256");

const controls = manifest.externalControls;
assertExactKeys(
  controls,
  [
    "developBranchProtectionVerified",
    "mainBranchProtectionVerified",
    "supabaseLeakedPasswordProtectionVerified",
    "supabaseProjectRef",
    "verifiedAt",
    "verifiedBy",
  ],
  "externalControls",
);
requireValue(controls.developBranchProtectionVerified === true, "develop branch protection/ruleset must be independently verified before production release.");
requireValue(controls.mainBranchProtectionVerified === true, "main branch protection/ruleset must be independently verified before production release.");
requireValue(controls.supabaseLeakedPasswordProtectionVerified === true, "Supabase leaked-password protection must be independently verified before production release.");
const supabaseProjectRef = cleanText(controls.supabaseProjectRef, "externalControls.supabaseProjectRef");
requireValue(PROJECT_REF.test(supabaseProjectRef), "externalControls.supabaseProjectRef must be a lowercase Supabase project reference.");
const controlsVerifiedAt = isoDate(controls.verifiedAt, "externalControls.verifiedAt");
requireValue(controlsVerifiedAt <= preparedAt, "externalControls.verifiedAt must not follow release.preparedAt.");
cleanText(controls.verifiedBy, "externalControls.verifiedBy");

const approval = manifest.approval;
assertExactKeys(approval, ["changeReference", "productionReleaseApproved", "approvedBy", "approvedAt"], "approval");
cleanText(approval.changeReference, "approval.changeReference");
requireValue(approval.productionReleaseApproved === true, "approval.productionReleaseApproved must be true.");
cleanText(approval.approvedBy, "approval.approvedBy");
const approvedAt = isoDate(approval.approvedAt, "approval.approvedAt");
requireValue(approvedAt >= preparedAt, "approval.approvedAt must not precede release.preparedAt.");
requireValue(approvedAt >= controlsVerifiedAt, "approval.approvedAt must not precede externalControls.verifiedAt.");

console.log(`Production release manifest is structurally ready for ${releaseVersion}.`);
console.log(`Source develop commit: ${release.sourceDevelopCommit}`);
console.log(`Chain: ${chain.networkName} (${chain.chainId}), validators: ${chain.validatorCount}`);
console.log(`Verified contracts: ${requiredContracts.join(", ")}`);
console.log(`Platform controls evidence is bound to Supabase project ${supabaseProjectRef}.`);
