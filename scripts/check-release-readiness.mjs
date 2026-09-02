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
const FORBIDDEN_TEXT = /(todo|tbd|placeholder|replace[-_ ]?me|example|dummy|changeme)/i;

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
  return text;
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
  return text;
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
requireValue(manifest.schemaVersion === 1, "schemaVersion must equal 1.");

const release = manifest.release;
requireValue(isRecord(release), "release section is required.");
const releaseVersion = cleanText(release.version, "release.version");
requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
requireValue(typeof release.sourceDevelopCommit === "string" && GIT_SHA.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must be a full 40-character Git SHA.");
requireValue(!/^0{40}$/i.test(release.sourceDevelopCommit), "release.sourceDevelopCommit must not be the zero SHA.");
isoDate(release.preparedAt, "release.preparedAt");
cleanText(release.preparedBy, "release.preparedBy");

const chain = manifest.chain;
requireValue(isRecord(chain), "chain section is required.");
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
const byName = new Map();
const contractAddresses = new Set();
for (const entry of contracts) {
  requireValue(isRecord(entry), "every contract entry must be an object.");
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
requireValue(isRecord(verifiers), "verifiers section is required.");
for (const key of ["capacitySpend", "capacityRelease"]) {
  const verifier = verifiers[key];
  requireValue(isRecord(verifier), `verifiers.${key} is required.`);
  requireValue(Number.isInteger(verifier.circuitVersion) && verifier.circuitVersion >= 1, `verifiers.${key}.circuitVersion must be a positive integer.`);
  address(verifier.address, `verifiers.${key}.address`);
  hash32(verifier.circuitArtifactHash, `verifiers.${key}.circuitArtifactHash`);
  hash32(verifier.verificationKeyHash, `verifiers.${key}.verificationKeyHash`);
  hash32(verifier.runtimeCodeHash, `verifiers.${key}.runtimeCodeHash`);
  hash32(verifier.buildAttestationSha256, `verifiers.${key}.buildAttestationSha256`);
  requireValue(verifier.setup === "production-ceremony", `verifiers.${key}.setup must equal production-ceremony.`);
  httpsUrl(verifier.ceremonyEvidenceUrl, `verifiers.${key}.ceremonyEvidenceUrl`);
  hash32(verifier.ceremonyEvidenceSha256, `verifiers.${key}.ceremonyEvidenceSha256`);
}

const signing = manifest.signing;
requireValue(isRecord(signing), "signing section is required.");
requireValue(signing.mode === "remote-web3signer", "signing.mode must equal remote-web3signer for production.");
requireValue(signing.kmsOrHsmBacked === true, "signing.kmsOrHsmBacked must be true.");
cleanText(signing.keyCustodyDescription, "signing.keyCustodyDescription");

const evidence = manifest.evidence;
requireValue(isRecord(evidence), "evidence section is required.");
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

const controls = manifest.externalControls;
requireValue(isRecord(controls), "externalControls section is required.");
requireValue(controls.developBranchProtectionVerified === true, "develop branch protection/ruleset must be independently verified before production release.");
requireValue(controls.mainBranchProtectionVerified === true, "main branch protection/ruleset must be independently verified before production release.");
requireValue(controls.supabaseLeakedPasswordProtectionVerified === true, "Supabase leaked-password protection must be independently verified before production release.");
isoDate(controls.verifiedAt, "externalControls.verifiedAt");
cleanText(controls.verifiedBy, "externalControls.verifiedBy");

const approval = manifest.approval;
requireValue(isRecord(approval), "approval section is required.");
cleanText(approval.changeReference, "approval.changeReference");
requireValue(approval.productionReleaseApproved === true, "approval.productionReleaseApproved must be true.");
cleanText(approval.approvedBy, "approval.approvedBy");
isoDate(approval.approvedAt, "approval.approvedAt");

console.log(`Production release manifest is structurally ready for ${releaseVersion}.`);
console.log(`Source develop commit: ${release.sourceDevelopCommit}`);
console.log(`Chain: ${chain.networkName} (${chain.chainId}), validators: ${chain.validatorCount}`);
console.log(`Verified contracts: ${requiredContracts.join(", ")}`);
