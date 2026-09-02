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
const SIMPLE_OUTAGE_CASES = new Set(["rpc_outage", "signer_outage"]);
const REQUIRED_CASE_ROLES = new Map([
  ["onboarding", ["factory", "auditor"]],
  ["credential_issue", ["auditor", "factory"]],
  ["credential_revocation", ["auditor", "factory"]],
  ["capacity_certification", ["auditor", "factory"]],
  ["order_authorization", ["buyer", "factory"]],
  ["pofc_spend", ["buyer", "factory"]],
  ["order_amendment", ["buyer", "factory"]],
  ["order_cancellation", ["buyer", "factory"]],
  ["capacity_release", ["buyer", "factory"]],
  ["due_process_disclosure", ["auditor", "regulator"]],
  ["credential_package_export", ["auditor", "factory"]],
  ["credential_package_verification", ["buyer"]],
  ["revoked_credential", ["auditor", "factory"]],
]);
const EXPECTED_CONTRACT_BY_CASE = new Map([
  ["onboarding", "Registry"],
  ["credential_issue", "CredentialRegistry"],
  ["credential_revocation", "CredentialRegistry"],
  ["capacity_certification", "CapacityVault"],
  ["order_authorization", "OrderRegistry"],
  ["pofc_spend", "CapacityVault"],
  ["subcontract_authorization", "SubcontractGovernor"],
  ["order_amendment", "OrderRegistry"],
  ["order_cancellation", "OrderRegistry"],
  ["capacity_release", "CapacityVault"],
  ["due_process_disclosure", "ThreadProofCharter"],
]);

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PARTICIPANT_ID = /^[a-z0-9][a-z0-9._:-]{2,79}$/;
const OPERATOR_ID = /^[A-Za-z0-9._:@/-]{3,160}$/;
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
function cleanText(value, label, minLength = 1) {
  requireValue(typeof value === "string" && value.trim().length >= minLength, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  return text;
}
function isoDate(value, label) {
  const text = cleanText(value, label);
  const millis = Date.parse(text);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text, millis };
}
function httpsUrl(value, label) {
  const text = cleanText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(parsed.protocol === "https:", `${label} must use https.`);
  requireValue(!parsed.username && !parsed.password, `${label} must not contain URL credentials.`);
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
function decimalBlock(value, label) {
  requireValue(typeof value === "string" && DECIMAL.test(value), `${label} must be a non-negative decimal string.`);
  return BigInt(value);
}

function scanUnsafe(value, objectPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafe(item, `${objectPath}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_KEY.test(key), `${objectPath}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${objectPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string") requireValue(!FORBIDDEN_TEXT.test(value), `${objectPath} contains placeholder text.`);
}

function validateTranscript(evidence, label) {
  requireValue(isRecord(evidence), `${label}.evidence is required.`);
  httpsUrl(evidence.transcriptUrl, `${label}.evidence.transcriptUrl`);
  sha256(evidence.transcriptSha256, `${label}.evidence.transcriptSha256`);
}

function validateReceipt(receipt, label, expectedChainId, caseId, expectedContracts) {
  requireValue(isRecord(receipt), `${label}.evidence.chainReceipt is required.`);
  requireValue(receipt.chainId === expectedChainId, `${label}.evidence.chainReceipt.chainId must equal ${expectedChainId}.`);
  hash32(receipt.transactionHash, `${label}.evidence.chainReceipt.transactionHash`);
  const blockNumber = decimalBlock(receipt.blockNumber, `${label}.evidence.chainReceipt.blockNumber`);
  requireValue(blockNumber > 0n, `${label}.evidence.chainReceipt.blockNumber must be positive.`);
  hash32(receipt.blockHash, `${label}.evidence.chainReceipt.blockHash`);
  const contractAddress = address(receipt.contractAddress, `${label}.evidence.chainReceipt.contractAddress`);
  cleanText(receipt.eventName, `${label}.evidence.chainReceipt.eventName`);
  const expectedContractName = EXPECTED_CONTRACT_BY_CASE.get(caseId);
  if (expectedContractName && expectedContracts) {
    const expectedAddress = expectedContracts.get(expectedContractName);
    requireValue(Boolean(expectedAddress), `release manifest is missing expected contract ${expectedContractName}.`);
    requireValue(contractAddress === expectedAddress, `${label}.evidence.chainReceipt.contractAddress must equal release ${expectedContractName}.`);
  }
}

function validatePackage(pkg, label, caseId) {
  requireValue(isRecord(pkg), `${label}.evidence.package is required.`);
  httpsUrl(pkg.url, `${label}.evidence.package.url`);
  sha256(pkg.sha256, `${label}.evidence.package.sha256`);
  const format = cleanText(pkg.format, `${label}.evidence.package.format`);
  const expectedFormat = EXPECTED_PACKAGE_FORMATS.get(caseId);
  requireValue(format === expectedFormat, `${label}.evidence.package.format must equal ${expectedFormat}.`);
}

function validateRejection(rejection, label) {
  requireValue(isRecord(rejection), `${label}.evidence.rejection is required.`);
  cleanText(rejection.errorCode, `${label}.evidence.rejection.errorCode`);
  sha256(rejection.requestSha256, `${label}.evidence.rejection.requestSha256`);
  requireValue(rejection.canonicalStateUnchanged === true, `${label}.evidence.rejection.canonicalStateUnchanged must be true.`);
  const before = hash32(rejection.beforeStateHash, `${label}.evidence.rejection.beforeStateHash`);
  const after = hash32(rejection.afterStateHash, `${label}.evidence.rejection.afterStateHash`);
  requireValue(before === after, `${label} changed canonical state despite a rejected adversarial request.`);
}

function validateSimpleOutage(outage, label, caseId) {
  requireValue(isRecord(outage), `${label}.evidence.outage is required.`);
  requireValue(outage.mode === caseId.replace("_outage", ""), `${label}.evidence.outage.mode does not match ${caseId}.`);
  requireValue(outage.operationRejected === true, `${label}.evidence.outage.operationRejected must be true.`);
  requireValue(outage.safetyPreserved === true, `${label}.evidence.outage.safetyPreserved must be true.`);
  requireValue(Number.isInteger(outage.observedDurationMs) && outage.observedDurationMs > 0, `${label}.evidence.outage.observedDurationMs must be a positive integer.`);
  const before = hash32(outage.beforeStateHash, `${label}.evidence.outage.beforeStateHash`);
  const after = hash32(outage.afterStateHash, `${label}.evidence.outage.afterStateHash`);
  requireValue(before === after, `${label} changed canonical state during the fail-closed outage observation.`);
}

function validateValidatorLoss(outage, label) {
  requireValue(isRecord(outage), `${label}.evidence.outage is required.`);
  requireValue(outage.mode === "validator", `${label}.evidence.outage.mode must equal validator.`);
  requireValue(outage.safetyPreserved === true, `${label}.evidence.outage.safetyPreserved must be true.`);

  requireValue(isRecord(outage.oneUnavailable), `${label}.evidence.outage.oneUnavailable is required.`);
  const oneStart = decimalBlock(outage.oneUnavailable.startBlock, `${label}.evidence.outage.oneUnavailable.startBlock`);
  const oneEnd = decimalBlock(outage.oneUnavailable.endBlock, `${label}.evidence.outage.oneUnavailable.endBlock`);
  requireValue(oneEnd - oneStart >= 2n, `${label} must show at least two finalized blocks with one validator unavailable.`);

  requireValue(isRecord(outage.quorumLost), `${label}.evidence.outage.quorumLost is required.`);
  const stalledStart = decimalBlock(outage.quorumLost.startBlock, `${label}.evidence.outage.quorumLost.startBlock`);
  const stalledEnd = decimalBlock(outage.quorumLost.endBlock, `${label}.evidence.outage.quorumLost.endBlock`);
  requireValue(stalledEnd === stalledStart, `${label} must show no finalized block progress after quorum loss.`);
  requireValue(outage.quorumLost.rpcResponsive === true, `${label}.evidence.outage.quorumLost.rpcResponsive must be true.`);
  requireValue(outage.quorumLost.operationRejected === true, `${label}.evidence.outage.quorumLost.operationRejected must be true.`);
  requireValue(Number.isInteger(outage.quorumLost.observedDurationMs) && outage.quorumLost.observedDurationMs > 0, `${label}.evidence.outage.quorumLost.observedDurationMs must be positive.`);
  const before = hash32(outage.quorumLost.beforeStateHash, `${label}.evidence.outage.quorumLost.beforeStateHash`);
  const after = hash32(outage.quorumLost.afterStateHash, `${label}.evidence.outage.quorumLost.afterStateHash`);
  requireValue(before === after, `${label} changed canonical state while quorum was unavailable.`);

  requireValue(isRecord(outage.recovered), `${label}.evidence.outage.recovered is required.`);
  const recoveredStart = decimalBlock(outage.recovered.startBlock, `${label}.evidence.outage.recovered.startBlock`);
  const recoveredEnd = decimalBlock(outage.recovered.endBlock, `${label}.evidence.outage.recovered.endBlock`);
  requireValue(recoveredEnd - recoveredStart >= 2n, `${label} must show at least two finalized blocks after quorum restoration.`);
}

function participantRoleSet(participantIds, participantsById) {
  return new Set(participantIds.map((participantId) => participantsById.get(participantId).role));
}

function validateCases(cases, kind, requiredIds, participantsById, chainId, windowStartMs, windowEndMs, expectedContracts) {
  requireValue(Array.isArray(cases), `${kind}Cases must be an array.`);
  const seen = new Set();
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
    requireValue(completedAt.millis >= startedAt.millis, `${label}.completedAt must not precede startedAt.`);
    requireValue(startedAt.millis >= windowStartMs && completedAt.millis <= windowEndMs, `${label} must fall within the top-level UAT execution window.`);
    cleanText(entry.expected, `${label}.expected`, 8);
    cleanText(entry.observed, `${label}.observed`, 8);

    requireValue(Array.isArray(entry.participantIds) && entry.participantIds.length > 0, `${label}.participantIds must be a non-empty array.`);
    const participantIds = [];
    const participantIdSet = new Set();
    for (const participantIdValue of entry.participantIds) {
      const participantId = cleanText(participantIdValue, `${label}.participantIds[]`);
      requireValue(PARTICIPANT_ID.test(participantId), `${label}.participantIds contains invalid participant ID ${participantId}.`);
      requireValue(participantsById.has(participantId), `${label}.participantIds references unknown participant ${participantId}.`);
      requireValue(!participantIdSet.has(participantId), `${label}.participantIds duplicates ${participantId}.`);
      participantIdSet.add(participantId);
      participantIds.push(participantId);
    }
    const roles = participantRoleSet(participantIds, participantsById);
    for (const requiredRole of REQUIRED_CASE_ROLES.get(id) ?? []) {
      requireValue(roles.has(requiredRole), `${label} must include ${requiredRole} participation.`);
    }
    if (id === "subcontract_authorization") {
      const factoryCount = participantIds.filter((participantId) => participantsById.get(participantId).role === "factory").length;
      requireValue(factoryCount >= 2, `${label} must include distinct parent and subcontract factory participants.`);
    }

    validateTranscript(entry.evidence, label);
    if (CHAIN_SUCCESS_CASES.has(id)) validateReceipt(entry.evidence.chainReceipt, label, chainId, id, expectedContracts);
    if (PACKAGE_CASES.has(id)) validatePackage(entry.evidence.package, label, id);
    if (REJECTION_CASES.has(id)) validateRejection(entry.evidence.rejection, label);
    if (SIMPLE_OUTAGE_CASES.has(id)) validateSimpleOutage(entry.evidence.outage, label, id);
    if (id === "validator_loss") validateValidatorLoss(entry.evidence.outage, label);
  }
  for (const required of requiredIds) requireValue(seen.has(required), `required ${kind} case ${required} is missing.`);
  requireValue(seen.size === requiredIds.length, `${kind}Cases must contain exactly the required case set.`);
}

function expectedContractsMap(value) {
  if (value === undefined) return undefined;
  requireValue(isRecord(value), "expected contracts must be an object keyed by contract name.");
  const result = new Map();
  for (const [name, contractAddress] of Object.entries(value)) result.set(name, address(contractAddress, `expected contract ${name}`));
  return result;
}

export function validateProductionUatEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  requireValue(evidence.format === UAT_FORMAT, `format must equal ${UAT_FORMAT}.`);
  requireValue(evidence.result === "pass", "top-level result must equal pass.");

  const releaseVersion = cleanText(evidence.releaseVersion, "releaseVersion");
  requireValue(VERSION.test(releaseVersion), "releaseVersion must be a semantic version such as v1.0.0.");
  if (expected.releaseVersion !== undefined) requireValue(releaseVersion === expected.releaseVersion, "releaseVersion does not match the release manifest.");
  const sourceDevelopCommit = gitSha(evidence.sourceDevelopCommit, "sourceDevelopCommit");
  if (expected.sourceDevelopCommit !== undefined) {
    requireValue(sourceDevelopCommit === gitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceDevelopCommit does not match the release source commit.");
  }
  requireValue(Number.isInteger(evidence.chainId) && evidence.chainId === 2026, "chainId must equal ThreadProof chain 2026.");
  if (expected.chainId !== undefined) requireValue(evidence.chainId === expected.chainId, "chainId does not match the release manifest.");
  const genesisHash = hash32(evidence.genesisHash, "genesisHash");
  if (expected.genesisHash !== undefined) requireValue(genesisHash === hash32(expected.genesisHash, "expected genesisHash"), "genesisHash does not match the release manifest.");
  requireValue(Number.isInteger(evidence.validatorCount) && evidence.validatorCount >= 5, "validatorCount must be at least 5.");
  if (expected.validatorCount !== undefined) requireValue(evidence.validatorCount === expected.validatorCount, "validatorCount does not match the release manifest.");
  const deploymentManifestSha256 = sha256(evidence.deploymentManifestSha256, "deploymentManifestSha256");
  if (expected.deploymentManifestSha256 !== undefined) {
    requireValue(deploymentManifestSha256 === sha256(expected.deploymentManifestSha256, "expected deploymentManifestSha256"), "deploymentManifestSha256 does not match the release manifest.");
  }
  requireValue(evidence.environment === "production", "environment must equal production.");
  requireValue(evidence.networkType === "persistent-consortium", "networkType must equal persistent-consortium.");
  requireValue(isRecord(evidence.signing), "signing section is required.");
  requireValue(evidence.signing.mode === "remote-web3signer", "signing.mode must equal remote-web3signer.");
  requireValue(evidence.signing.kmsOrHsmBacked === true, "signing.kmsOrHsmBacked must be true.");
  if (expected.signerMode !== undefined) requireValue(evidence.signing.mode === expected.signerMode, "signing.mode does not match the release manifest.");
  if (expected.kmsOrHsmBacked !== undefined) requireValue(evidence.signing.kmsOrHsmBacked === expected.kmsOrHsmBacked, "signing.kmsOrHsmBacked does not match the release manifest.");

  const startedAt = isoDate(evidence.startedAt, "startedAt");
  const completedAt = isoDate(evidence.completedAt, "completedAt");
  requireValue(completedAt.millis >= startedAt.millis, "completedAt must not precede startedAt.");
  if (expected.preparedAt !== undefined) {
    const preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(completedAt.millis <= preparedAt.millis, "UAT completedAt must not be after release.preparedAt.");
  }

  requireValue(Array.isArray(evidence.participants) && evidence.participants.length >= 6, "participants must contain at least six distinct consortium identities, including two factories.");
  const participantsById = new Map();
  const organizations = new Set();
  const wallets = new Set();
  const roleCounts = new Map();
  for (let index = 0; index < evidence.participants.length; index += 1) {
    const participant = evidence.participants[index];
    const label = `participants[${index}]`;
    requireValue(isRecord(participant), `${label} must be an object.`);
    const participantId = cleanText(participant.participantId, `${label}.participantId`);
    requireValue(PARTICIPANT_ID.test(participantId), `${label}.participantId has an invalid format.`);
    requireValue(!participantsById.has(participantId), `participantId ${participantId} is duplicated.`);
    requireValue(REQUIRED_ROLES.includes(participant.role), `${label}.role is invalid.`);
    const organizationId = hash32(participant.organizationId, `${label}.organizationId`);
    requireValue(!organizations.has(organizationId), `${label}.organizationId is not distinct.`);
    organizations.add(organizationId);
    const walletAddress = address(participant.walletAddress, `${label}.walletAddress`);
    requireValue(!wallets.has(walletAddress), `${label}.walletAddress is not distinct.`);
    wallets.add(walletAddress);
    participantsById.set(participantId, { participantId, role: participant.role, organizationId, walletAddress });
    roleCounts.set(participant.role, (roleCounts.get(participant.role) ?? 0) + 1);
  }
  for (const role of REQUIRED_ROLES) requireValue((roleCounts.get(role) ?? 0) >= 1, `participant role ${role} is missing.`);
  requireValue((roleCounts.get("factory") ?? 0) >= 2, "participants must include distinct primary and subcontract factory identities.");

  const contracts = expectedContractsMap(expected.contracts);
  validateCases(evidence.functionalCases, "functional", REQUIRED_FUNCTIONAL_CASES, participantsById, evidence.chainId, startedAt.millis, completedAt.millis, contracts);
  validateCases(evidence.adversarialCases, "adversarial", REQUIRED_ADVERSARIAL_CASES, participantsById, evidence.chainId, startedAt.millis, completedAt.millis, contracts);

  requireValue(isRecord(evidence.signoff), "signoff section is required.");
  const executedBy = cleanText(evidence.signoff.executedBy, "signoff.executedBy");
  requireValue(OPERATOR_ID.test(executedBy), "signoff.executedBy must be a non-secret operator identifier.");
  requireValue(Array.isArray(evidence.signoff.reviewerParticipantIds) && evidence.signoff.reviewerParticipantIds.length >= 2, "signoff.reviewerParticipantIds must contain at least two reviewers.");
  const reviewerIds = new Set();
  for (const reviewerValue of evidence.signoff.reviewerParticipantIds) {
    const reviewerId = cleanText(reviewerValue, "signoff.reviewerParticipantIds[]");
    requireValue(participantsById.has(reviewerId), `signoff references unknown reviewer participant ${reviewerId}.`);
    requireValue(!reviewerIds.has(reviewerId), `signoff reviewer ${reviewerId} is duplicated.`);
    reviewerIds.add(reviewerId);
  }
  const reviewerRoles = participantRoleSet([...reviewerIds], participantsById);
  requireValue(reviewerRoles.has("auditor") && reviewerRoles.has("regulator"), "signoff must include both auditor and regulator reviewers.");
  const approvedAt = isoDate(evidence.signoff.approvedAt, "signoff.approvedAt");
  requireValue(approvedAt.millis >= completedAt.millis, "signoff.approvedAt must not predate UAT completion.");
  if (expected.preparedAt !== undefined) {
    const preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(approvedAt.millis <= preparedAt.millis, "signoff.approvedAt must not be after release.preparedAt.");
  }
  cleanText(evidence.signoff.statement, "signoff.statement", 24);

  return {
    format: evidence.format,
    result: evidence.result,
    releaseVersion,
    sourceDevelopCommit,
    chainId: evidence.chainId,
    validatorCount: evidence.validatorCount,
    participantCount: evidence.participants.length,
    functionalCaseCount: evidence.functionalCases.length,
    adversarialCaseCount: evidence.adversarialCases.length,
  };
}

export async function loadAndValidateProductionUatEvidence(filePath, expected = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(filePath, "utf8")); } catch (error) {
    fail(`could not read valid JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
    releaseVersion: process.env.THREADPROOF_EXPECTED_RELEASE_VERSION,
    sourceDevelopCommit: process.env.THREADPROOF_EXPECTED_SOURCE_COMMIT,
    chainId: process.env.THREADPROOF_EXPECTED_CHAIN_ID ? Number(process.env.THREADPROOF_EXPECTED_CHAIN_ID) : undefined,
    genesisHash: process.env.THREADPROOF_EXPECTED_GENESIS_HASH,
    validatorCount: process.env.THREADPROOF_EXPECTED_VALIDATOR_COUNT ? Number(process.env.THREADPROOF_EXPECTED_VALIDATOR_COUNT) : undefined,
    deploymentManifestSha256: process.env.THREADPROOF_EXPECTED_DEPLOYMENT_MANIFEST_SHA256,
    signerMode: process.env.THREADPROOF_EXPECTED_SIGNER_MODE,
    kmsOrHsmBacked: process.env.THREADPROOF_EXPECTED_KMS_HSM === undefined ? undefined : process.env.THREADPROOF_EXPECTED_KMS_HSM === "true",
    preparedAt: process.env.THREADPROOF_EXPECTED_PREPARED_AT,
  }).then((summary) => {
    console.log(`Production UAT/adversarial evidence verified: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
