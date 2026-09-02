import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const UAT_FORMAT = "threadproof-production-uat/v1";
export const REQUIRED_ROLES = ["buyer", "factory", "auditor", "regulator", "worker_labor"];
export const REQUIRED_FUNCTIONAL_CASES = [
  "onboarding",
  "credential_issue",
  "credential_revocation",
  "capacity_certification",
  "order_authorization",
  "pofc_spend",
  "subcontract_authorization",
  "order_amendment",
  "order_cancellation",
  "capacity_release",
  "due_process_disclosure",
  "credential_package_export",
  "credential_package_verification",
];
export const REQUIRED_ADVERSARIAL_CASES = [
  "stale_capacity",
  "duplicate_nullifier",
  "invalid_proof",
  "invalid_allocation",
  "release_replay",
  "revoked_credential",
  "rpc_outage",
  "signer_outage",
  "validator_loss",
];

const CHAIN_SUCCESS_CASES = new Set([
  "onboarding",
  "credential_issue",
  "credential_revocation",
  "capacity_certification",
  "order_authorization",
  "pofc_spend",
  "subcontract_authorization",
  "order_amendment",
  "order_cancellation",
  "capacity_release",
  "due_process_disclosure",
]);
const PACKAGE_CASES = new Set(["due_process_disclosure", "credential_package_export", "credential_package_verification"]);
const EXPECTED_PACKAGE_FORMATS = new Map([
  ["due_process_disclosure", "threadproof-protected-identity-disclosure/v1"],
  ["credential_package_export", "threadproof-credential-package/v1"],
  ["credential_package_verification", "threadproof-credential-package/v1"],
]);
const REJECTION_CASES = new Set([
  "stale_capacity",
  "duplicate_nullifier",
  "invalid_proof",
  "invalid_allocation",
  "release_replay",
  "revoked_credential",
]);
const OUTAGE_CASES = new Set(["rpc_outage", "signer_outage", "validator_loss"]);
const REQUIRED_CASE_ROLES = new Map([
  ["onboarding", ["factory", "auditor"]],
  ["credential_issue", ["auditor", "factory"]],
  ["credential_revocation", ["auditor"]],
  ["capacity_certification", ["auditor", "factory"]],
  ["order_authorization", ["buyer"]],
  ["pofc_spend", ["factory"]],
  ["subcontract_authorization", ["factory"]],
  ["order_amendment", ["buyer"]],
  ["order_cancellation", ["buyer"]],
  ["capacity_release", ["factory"]],
  ["due_process_disclosure", ["auditor", "regulator"]],
  ["credential_package_export", ["auditor"]],
  ["credential_package_verification", ["buyer"]],
  ["revoked_credential", ["auditor"]],
]);

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FORBIDDEN_TEXT = /(^|[^a-z])(todo|tbd|placeholder|replace[_ -]?me|dummy|changeme|example)([^a-z]|$)/i;
const FORBIDDEN_KEY = /(password|secret|private.?key|mnemonic|seed.?phrase|access.?token|service.?role|api.?key|email|full.?name|worker.?name|supplier.?name|phone(number)?)/i;

function fail(message) {
  throw new Error(`Production UAT evidence invalid: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  return text;
}
function isoDate(value, label) {
  const text = cleanText(value, label);
  requireValue(Number.isFinite(Date.parse(text)), `${label} must be an ISO-8601 timestamp.`);
  return text;
}
function httpsUrl(value, label) {
  const text = cleanText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(parsed.protocol === "https:", `${label} must use https.`);
  return text;
}
function hash32(value, label) {
  requireValue(typeof value === "string" && HEX_32.test(value), `${label} must be a 32-byte 0x-prefixed hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function address(value, label) {
  requireValue(typeof value === "string" && HEX_20.test(value), `${label} must be an EVM address.`);
  requireValue(!/^0x0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function sha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 hex digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function gitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}

function scanUnsafe(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafe(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_KEY.test(key), `${path}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    requireValue(!FORBIDDEN_TEXT.test(value), `${path} contains placeholder text.`);
  }
}

function validateTranscript(evidence, label) {
  requireValue(isRecord(evidence), `${label}.evidence is required.`);
  httpsUrl(evidence.transcriptUrl, `${label}.evidence.transcriptUrl`);
  sha256(evidence.transcriptSha256, `${label}.evidence.transcriptSha256`);
}

function validateReceipt(receipt, label, expectedChainId) {
  requireValue(isRecord(receipt), `${label}.chainReceipt is required.`);
  requireValue(receipt.chainId === expectedChainId, `${label}.chainReceipt.chainId must equal ${expectedChainId}.`);
  hash32(receipt.transactionHash, `${label}.chainReceipt.transactionHash`);
  requireValue(typeof receipt.blockNumber === "string" && DECIMAL.test(receipt.blockNumber), `${label}.chainReceipt.blockNumber must be a decimal string.`);
  hash32(receipt.blockHash, `${label}.chainReceipt.blockHash`);
  address(receipt.contractAddress, `${label}.chainReceipt.contractAddress`);
  cleanText(receipt.eventName, `${label}.chainReceipt.eventName`);
}

function validatePackage(pkg, label, caseId) {
  requireValue(isRecord(pkg), `${label}.package is required.`);
  httpsUrl(pkg.url, `${label}.package.url`);
  sha256(pkg.sha256, `${label}.package.sha256`);
  const format = cleanText(pkg.format, `${label}.package.format`);
  const expectedFormat = EXPECTED_PACKAGE_FORMATS.get(caseId);
  requireValue(format === expectedFormat, `${label}.package.format must equal ${expectedFormat}.`);
}

function validateRejection(rejection, label) {
  requireValue(isRecord(rejection), `${label}.rejection is required.`);
  cleanText(rejection.errorCode, `${label}.rejection.errorCode`);
  sha256(rejection.requestSha256, `${label}.rejection.requestSha256`);
  requireValue(rejection.canonicalStateUnchanged === true, `${label}.rejection.canonicalStateUnchanged must be true.`);
  const before = hash32(rejection.beforeStateHash, `${label}.rejection.beforeStateHash`);
  const after = hash32(rejection.afterStateHash, `${label}.rejection.afterStateHash`);
  requireValue(before === after, `${label} changed canonical state despite being a rejected adversarial case.`);
}

function validateOutage(outage, label, caseId) {
  requireValue(isRecord(outage), `${label}.outage is required.`);
  requireValue(outage.mode === caseId.replace("_outage", "") || (caseId === "validator_loss" && outage.mode === "validator"), `${label}.outage.mode does not match ${caseId}.`);
  requireValue(outage.operationRejected === true, `${label}.outage.operationRejected must be true.`);
  requireValue(outage.safetyPreserved === true, `${label}.outage.safetyPreserved must be true.`);
  requireValue(Number.isInteger(outage.observedDurationMs) && outage.observedDurationMs > 0, `${label}.outage.observedDurationMs must be a positive integer.`);
  if (caseId === "validator_loss") {
    requireValue(outage.validatorToleranceObserved === true, `${label}.outage.validatorToleranceObserved must be true.`);
    requireValue(outage.quorumLossFailClosedObserved === true, `${label}.outage.quorumLossFailClosedObserved must be true.`);
    requireValue(outage.recoveryObserved === true, `${label}.outage.recoveryObserved must be true.`);
  }
  const before = hash32(outage.beforeStateHash, `${label}.outage.beforeStateHash`);
  const after = hash32(outage.afterStateHash, `${label}.outage.afterStateHash`);
  requireValue(before === after, `${label} changed canonical state during the fail-closed observation.`);
}

function validateCases(cases, kind, requiredIds, participants, chainId, windowStartMs, windowEndMs) {
  requireValue(Array.isArray(cases), `${kind}Cases must be an array.`);
  const seen = new Set();
  const knownRoles = new Set(participants.map((participant) => participant.role));
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];
    const label = `${kind}Cases[${index}]`;
    requireValue(isRecord(entry), `${label} must be an object.`);
    const id = cleanText(entry.id, `${label}.id`);
    requireValue(requiredIds.includes(id), `${label}.id ${id} is not a recognized required ${kind} case.`);
    requireValue(!seen.has(id), `${kind} case ${id} is duplicated.`);
    seen.add(id);
    requireValue(entry.result === "pass", `${label}.result must equal pass.`);
    const startedAt = isoDate(entry.startedAt, `${label}.startedAt`);
    const completedAt = isoDate(entry.completedAt, `${label}.completedAt`);
    const caseStartMs = Date.parse(startedAt);
    const caseEndMs = Date.parse(completedAt);
    requireValue(caseEndMs >= caseStartMs, `${label}.completedAt must not precede startedAt.`);
    requireValue(caseStartMs >= windowStartMs && caseEndMs <= windowEndMs, `${label} must fall within the top-level UAT execution window.`);
    requireValue(Array.isArray(entry.participantRoles) && entry.participantRoles.length > 0, `${label}.participantRoles must be a non-empty array.`);
    const caseRoles = new Set();
    for (const role of entry.participantRoles) {
      requireValue(REQUIRED_ROLES.includes(role), `${label}.participantRoles contains unknown role ${String(role)}.`);
      requireValue(knownRoles.has(role), `${label}.participantRoles references role ${role} absent from participants.`);
      requireValue(!caseRoles.has(role), `${label}.participantRoles duplicates ${role}.`);
      caseRoles.add(role);
    }
    for (const requiredRole of REQUIRED_CASE_ROLES.get(id) ?? []) {
      requireValue(caseRoles.has(requiredRole), `${label} must include ${requiredRole} participation.`);
    }
    validateTranscript(entry.evidence, label);
    if (CHAIN_SUCCESS_CASES.has(id)) validateReceipt(entry.evidence.chainReceipt, label, chainId);
    if (PACKAGE_CASES.has(id)) validatePackage(entry.evidence.package, label, id);
    if (REJECTION_CASES.has(id)) validateRejection(entry.evidence.rejection, label);
    if (OUTAGE_CASES.has(id)) validateOutage(entry.evidence.outage, label, id);
  }
  for (const required of requiredIds) requireValue(seen.has(required), `required ${kind} case ${required} is missing.`);
  requireValue(seen.size === requiredIds.length, `${kind}Cases must contain exactly the required case set.`);
}

export function validateProductionUatEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  requireValue(evidence.format === UAT_FORMAT, `format must equal ${UAT_FORMAT}.`);
  requireValue(evidence.result === "pass", "top-level result must equal pass.");
  const sourceDevelopCommit = gitSha(evidence.sourceDevelopCommit, "sourceDevelopCommit");
  if (expected.sourceDevelopCommit !== undefined) {
    requireValue(sourceDevelopCommit === gitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceDevelopCommit does not match the release source commit.");
  }
  requireValue(Number.isInteger(evidence.chainId) && evidence.chainId === 2026, "chainId must equal ThreadProof chain 2026.");
  if (expected.chainId !== undefined) requireValue(evidence.chainId === expected.chainId, "chainId does not match the release manifest.");
  const genesisHash = hash32(evidence.genesisHash, "genesisHash");
  if (expected.genesisHash !== undefined) requireValue(genesisHash === hash32(expected.genesisHash, "expected genesisHash"), "genesisHash does not match the release manifest.");
  const deploymentManifestSha256 = sha256(evidence.deploymentManifestSha256, "deploymentManifestSha256");
  if (expected.deploymentManifestSha256 !== undefined) {
    requireValue(deploymentManifestSha256 === sha256(expected.deploymentManifestSha256, "expected deploymentManifestSha256"), "deploymentManifestSha256 does not match the release manifest.");
  }
  requireValue(evidence.environment === "production", "environment must equal production.");
  requireValue(evidence.networkType === "persistent-consortium", "networkType must equal persistent-consortium.");
  const startedAt = isoDate(evidence.startedAt, "startedAt");
  const completedAt = isoDate(evidence.completedAt, "completedAt");
  requireValue(Date.parse(completedAt) >= Date.parse(startedAt), "completedAt must not precede startedAt.");

  requireValue(Array.isArray(evidence.participants), "participants must be an array.");
  requireValue(evidence.participants.length === REQUIRED_ROLES.length, `participants must contain exactly ${REQUIRED_ROLES.length} consortium roles.`);
  const roles = new Set();
  const orgs = new Set();
  const wallets = new Set();
  for (let index = 0; index < evidence.participants.length; index += 1) {
    const participant = evidence.participants[index];
    const label = `participants[${index}]`;
    requireValue(isRecord(participant), `${label} must be an object.`);
    requireValue(REQUIRED_ROLES.includes(participant.role), `${label}.role is invalid.`);
    requireValue(!roles.has(participant.role), `participant role ${participant.role} is duplicated.`);
    roles.add(participant.role);
    const org = hash32(participant.organizationId, `${label}.organizationId`);
    requireValue(!orgs.has(org), `${label}.organizationId is not distinct.`);
    orgs.add(org);
    const wallet = address(participant.walletAddress, `${label}.walletAddress`);
    requireValue(!wallets.has(wallet), `${label}.walletAddress is not distinct.`);
    wallets.add(wallet);
  }
  for (const role of REQUIRED_ROLES) requireValue(roles.has(role), `participant role ${role} is missing.`);

  const windowStartMs = Date.parse(startedAt);
  const windowEndMs = Date.parse(completedAt);
  validateCases(evidence.functionalCases, "functional", REQUIRED_FUNCTIONAL_CASES, evidence.participants, evidence.chainId, windowStartMs, windowEndMs);
  validateCases(evidence.adversarialCases, "adversarial", REQUIRED_ADVERSARIAL_CASES, evidence.participants, evidence.chainId, windowStartMs, windowEndMs);

  return {
    format: evidence.format,
    result: evidence.result,
    sourceDevelopCommit,
    chainId: evidence.chainId,
    participantCount: evidence.participants.length,
    functionalCaseCount: evidence.functionalCases.length,
    adversarialCaseCount: evidence.adversarialCases.length,
  };
}

export async function loadAndValidateProductionUatEvidence(path, expected = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    fail(`could not read valid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateProductionUatEvidence(parsed, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidencePath = process.argv[2] ?? process.env.THREADPROOF_UAT_EVIDENCE_PATH;
  if (!evidencePath) {
    console.error("Usage: node scripts/production-uat-evidence.mjs <production-uat-evidence.json>");
    process.exit(2);
  }
  loadAndValidateProductionUatEvidence(evidencePath, {
    sourceDevelopCommit: process.env.THREADPROOF_EXPECTED_SOURCE_COMMIT,
    chainId: process.env.THREADPROOF_EXPECTED_CHAIN_ID ? Number(process.env.THREADPROOF_EXPECTED_CHAIN_ID) : undefined,
    genesisHash: process.env.THREADPROOF_EXPECTED_GENESIS_HASH,
    deploymentManifestSha256: process.env.THREADPROOF_EXPECTED_DEPLOYMENT_MANIFEST_SHA256,
  }).then((summary) => {
    console.log(`Production UAT/adversarial evidence verified: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
