#!/usr/bin/env node

const FORMAT = "threadproof-production-verifier-governance/v1";
const REQUIRED_ROLE_MASK = 0x0c; // Auditor | Regulator.
const ALL_CONSTITUENCIES_MASK = 0x1f;
const MIN_APPROVALS = 4;
const MIN_TIMELOCK_SECONDS = 24 * 60 * 60;
const MAX_OBSERVATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FORBIDDEN_TEXT = /(^|[^a-z])(todo|tbd|placeholder|replace[_ -]?me|dummy|changeme|example)([^a-z]|$)/i;
const FORBIDDEN_VALUE = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|seed phrase|mnemonic phrase|bearer\s+[A-Za-z0-9._-]{12,})/i;
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "password", "passwordvalue", "privatekey", "privatekeypem", "mnemonic", "seedphrase",
  "accesstoken", "refreshtoken", "servicerolekey", "apikey", "clientsecret", "bearer", "authorizationheader",
]);

function fail(message) { throw new Error(`Production verifier-governance evidence invalid: ${message}`); }
function requireValue(condition, message) { if (!condition) fail(message); }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function normalizedKey(key) { return key.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function assertExactKeys(record, allowedKeys, label) {
  requireValue(isRecord(record), `${label} must be an object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) requireValue(allowed.has(key), `${label} contains unexpected field ${key}.`);
  for (const key of allowedKeys) requireValue(Object.hasOwn(record, key), `${label}.${key} is required.`);
}
function scanUnsafe(value, objectPath = "evidence") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanUnsafe(item, `${objectPath}[${index}]`));
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey(key)), `${objectPath}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${objectPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    requireValue(!FORBIDDEN_TEXT.test(value), `${objectPath} contains placeholder text.`);
    requireValue(!FORBIDDEN_VALUE.test(value), `${objectPath} appears to contain secret material.`);
    if (value.includes("://")) {
      try {
        const url = new URL(value);
        requireValue(!url.username && !url.password, `${objectPath} contains a credential-bearing URL.`);
      } catch {
        // Owning fields validate URLs where URLs are expected.
      }
    }
  }
}
function cleanText(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  requireValue(!FORBIDDEN_VALUE.test(text), `${label} appears to contain secret material.`);
  return text;
}
function requireGitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value) && !/^0{40}$/i.test(value), `${label} must be a non-zero full Git SHA.`);
  return value.toLowerCase();
}
function requireHash32(value, label) {
  requireValue(typeof value === "string" && HEX_32.test(value) && !/^0x0{64}$/i.test(value), `${label} must be a non-zero 32-byte 0x-prefixed hash.`);
  return value.toLowerCase();
}
function requireAddress(value, label) {
  requireValue(typeof value === "string" && HEX_20.test(value) && !/^0x0{40}$/i.test(value), `${label} must be a non-zero EVM address.`);
  return value.toLowerCase();
}
function requireIso(value, label) {
  const text = cleanText(value, label);
  const millis = Date.parse(text);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text, millis };
}
function requirePositiveSafeInteger(value, label) {
  requireValue(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer.`);
  return value;
}
function requireMask(value, label) {
  requireValue(Number.isInteger(value) && value > 0 && value <= ALL_CONSTITUENCIES_MASK, `${label} must be a non-zero five-constituency bit mask.`);
  return value;
}
function popcount(value) {
  let count = 0;
  for (let bit = 0; bit < 5; bit += 1) if ((value & (1 << bit)) !== 0) count += 1;
  return count;
}
function contractAddress(expected, name) {
  const entry = expected.contracts?.find((item) => item?.name === name);
  requireValue(entry, `release manifest is missing contract ${name}.`);
  return requireAddress(entry.address, `release contract ${name} address`);
}

function validateRegistration(registration, label, expectedVerifier, { proposalType, proposalTypeCode }) {
  assertExactKeys(registration, [
    "proposalId", "proposalType", "proposalTypeCode", "actionHash", "circuitVersion", "verifierAddress",
    "circuitArtifactHash", "verificationKeyHash", "proposalState", "policyVersion", "approvalsReceived",
    "approvalsRequired", "eligibleMask", "requiredMask", "approvalMask", "timelockSeconds", "approvedAt",
    "executeAfter", "execution",
  ], label);

  const proposalId = requireHash32(registration.proposalId, `${label}.proposalId`);
  requireValue(registration.proposalType === proposalType, `${label}.proposalType must equal ${proposalType}.`);
  requireValue(registration.proposalTypeCode === proposalTypeCode, `${label}.proposalTypeCode must equal ${proposalTypeCode}.`);
  const actionHash = requireHash32(registration.actionHash, `${label}.actionHash`);
  requireValue(registration.proposalState === "executed", `${label}.proposalState must equal executed.`);

  requireValue(Number.isInteger(registration.circuitVersion) && registration.circuitVersion >= 1, `${label}.circuitVersion must be positive.`);
  requireValue(registration.circuitVersion === expectedVerifier.circuitVersion, `${label}.circuitVersion does not match release manifest.`);
  const verifierAddress = requireAddress(registration.verifierAddress, `${label}.verifierAddress`);
  requireValue(verifierAddress === requireAddress(expectedVerifier.address, `manifest ${label} verifier address`), `${label}.verifierAddress does not match release manifest.`);
  const circuitArtifactHash = requireHash32(registration.circuitArtifactHash, `${label}.circuitArtifactHash`);
  requireValue(circuitArtifactHash === requireHash32(expectedVerifier.circuitArtifactHash, `manifest ${label} circuitArtifactHash`), `${label}.circuitArtifactHash does not match release manifest.`);
  const verificationKeyHash = requireHash32(registration.verificationKeyHash, `${label}.verificationKeyHash`);
  requireValue(verificationKeyHash === requireHash32(expectedVerifier.verificationKeyHash, `manifest ${label} verificationKeyHash`), `${label}.verificationKeyHash does not match release manifest.`);

  requireValue(Number.isSafeInteger(registration.policyVersion) && registration.policyVersion >= 1, `${label}.policyVersion must be positive.`);
  requireValue(Number.isInteger(registration.approvalsRequired) && registration.approvalsRequired >= MIN_APPROVALS && registration.approvalsRequired <= 5, `${label}.approvalsRequired must be between ${MIN_APPROVALS} and 5.`);
  requireValue(Number.isInteger(registration.approvalsReceived) && registration.approvalsReceived >= registration.approvalsRequired && registration.approvalsReceived <= 5, `${label}.approvalsReceived must satisfy the snapshotted threshold.`);
  const eligibleMask = requireMask(registration.eligibleMask, `${label}.eligibleMask`);
  const requiredMask = requireMask(registration.requiredMask, `${label}.requiredMask`);
  const approvalMask = requireMask(registration.approvalMask, `${label}.approvalMask`);
  requireValue((requiredMask & REQUIRED_ROLE_MASK) === REQUIRED_ROLE_MASK, `${label}.requiredMask must require Auditor and Regulator.`);
  requireValue((requiredMask & ~eligibleMask) === 0, `${label}.requiredMask must be a subset of eligibleMask.`);
  requireValue((approvalMask & ~eligibleMask) === 0, `${label}.approvalMask must be a subset of eligibleMask.`);
  requireValue((approvalMask & requiredMask) === requiredMask, `${label}.approvalMask must include every required constituency.`);
  requireValue((approvalMask & REQUIRED_ROLE_MASK) === REQUIRED_ROLE_MASK, `${label}.approvalMask must include Auditor and Regulator approvals.`);
  requireValue(popcount(approvalMask) === registration.approvalsReceived, `${label}.approvalMask bit count must equal approvalsReceived.`);
  requireValue(popcount(eligibleMask) >= registration.approvalsRequired, `${label}.eligibleMask cannot satisfy approvalsRequired.`);

  requireValue(Number.isSafeInteger(registration.timelockSeconds) && registration.timelockSeconds >= MIN_TIMELOCK_SECONDS, `${label}.timelockSeconds must be at least ${MIN_TIMELOCK_SECONDS}.`);
  const approvedAt = requireIso(registration.approvedAt, `${label}.approvedAt`);
  const executeAfter = requireIso(registration.executeAfter, `${label}.executeAfter`);
  requireValue(executeAfter.millis === approvedAt.millis + registration.timelockSeconds * 1000, `${label}.executeAfter must equal approvedAt + timelockSeconds.`);

  assertExactKeys(registration.execution, ["txHash", "blockNumber", "blockHash", "executedAt", "executorAddress"], `${label}.execution`);
  const txHash = requireHash32(registration.execution.txHash, `${label}.execution.txHash`);
  const blockNumber = requirePositiveSafeInteger(registration.execution.blockNumber, `${label}.execution.blockNumber`);
  const blockHash = requireHash32(registration.execution.blockHash, `${label}.execution.blockHash`);
  const executedAt = requireIso(registration.execution.executedAt, `${label}.execution.executedAt`);
  requireValue(executedAt.millis >= executeAfter.millis, `${label}.execution.executedAt must not precede executeAfter.`);
  const executorAddress = requireAddress(registration.execution.executorAddress, `${label}.execution.executorAddress`);

  return {
    proposalId, proposalType, proposalTypeCode, actionHash, circuitVersion: registration.circuitVersion,
    verifierAddress, circuitArtifactHash, verificationKeyHash, policyVersion: registration.policyVersion,
    approvalsReceived: registration.approvalsReceived, approvalsRequired: registration.approvalsRequired,
    eligibleMask, requiredMask, approvalMask, timelockSeconds: registration.timelockSeconds,
    approvedAt, executeAfter, txHash, blockNumber, blockHash, executedAt, executorAddress,
  };
}

export function validateProductionVerifierGovernanceEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  assertExactKeys(evidence, ["format", "result", "environment", "releaseVersion", "sourceDevelopCommit", "observedAt", "chain", "contracts", "registrations"], "evidence");
  requireValue(evidence.format === FORMAT, `format must equal ${FORMAT}.`);
  requireValue(evidence.result === "pass", "result must equal pass.");
  requireValue(evidence.environment === "production", "environment must equal production.");

  const releaseVersion = cleanText(evidence.releaseVersion, "releaseVersion");
  requireValue(VERSION.test(releaseVersion), "releaseVersion must be semantic version text.");
  if (expected.releaseVersion) requireValue(releaseVersion === expected.releaseVersion, "releaseVersion does not match release manifest.");
  const sourceDevelopCommit = requireGitSha(evidence.sourceDevelopCommit, "sourceDevelopCommit");
  if (expected.sourceDevelopCommit) requireValue(sourceDevelopCommit === requireGitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceDevelopCommit does not match release manifest.");
  const observedAt = requireIso(evidence.observedAt, "observedAt");
  let preparedAt = null;
  if (expected.preparedAt) {
    preparedAt = requireIso(expected.preparedAt, "release.preparedAt");
    requireValue(observedAt.millis <= preparedAt.millis, "observedAt must not be after release.preparedAt.");
    requireValue(preparedAt.millis - observedAt.millis <= MAX_OBSERVATION_AGE_MS, "verifier-governance evidence is older than seven days at release.preparedAt.");
  }

  assertExactKeys(evidence.chain, ["chainId", "genesisHash"], "chain");
  requireValue(evidence.chain.chainId === 2026, "chain.chainId must equal 2026.");
  if (expected.chainId !== undefined) requireValue(evidence.chain.chainId === expected.chainId, "chain.chainId does not match release manifest.");
  const genesisHash = requireHash32(evidence.chain.genesisHash, "chain.genesisHash");
  if (expected.genesisHash) requireValue(genesisHash === requireHash32(expected.genesisHash, "expected chain.genesisHash"), "chain.genesisHash does not match release manifest.");

  assertExactKeys(evidence.contracts, ["capacityVault", "threadProofCharter"], "contracts");
  const capacityVault = requireAddress(evidence.contracts.capacityVault, "contracts.capacityVault");
  const threadProofCharter = requireAddress(evidence.contracts.threadProofCharter, "contracts.threadProofCharter");
  if (expected.contracts) {
    requireValue(capacityVault === contractAddress(expected, "CapacityVault"), "contracts.capacityVault does not match release manifest.");
    requireValue(threadProofCharter === contractAddress(expected, "ThreadProofCharter"), "contracts.threadProofCharter does not match release manifest.");
  }
  requireValue(capacityVault !== threadProofCharter, "CapacityVault and ThreadProofCharter addresses must be distinct.");

  assertExactKeys(evidence.registrations, ["capacitySpend", "capacityRelease"], "registrations");
  requireValue(isRecord(expected.verifiers?.capacitySpend) && isRecord(expected.verifiers?.capacityRelease), "expected release verifier bindings are required.");
  const capacitySpend = validateRegistration(evidence.registrations.capacitySpend, "registrations.capacitySpend", expected.verifiers.capacitySpend, {
    proposalType: "VerifierRegistration", proposalTypeCode: 8,
  });
  const capacityRelease = validateRegistration(evidence.registrations.capacityRelease, "registrations.capacityRelease", expected.verifiers.capacityRelease, {
    proposalType: "ReleaseVerifierRegistration", proposalTypeCode: 14,
  });
  requireValue(capacitySpend.proposalId !== capacityRelease.proposalId, "spend and release verifier registrations must use distinct Charter proposals.");
  requireValue(capacitySpend.txHash !== capacityRelease.txHash, "spend and release verifier registrations must use distinct execution transactions.");
  for (const registration of [capacitySpend, capacityRelease]) {
    requireValue(registration.executedAt.millis <= observedAt.millis, `${registration.proposalType} execution must not be after observedAt.`);
    if (preparedAt) requireValue(registration.executedAt.millis <= preparedAt.millis, `${registration.proposalType} execution must not be after release.preparedAt.`);
  }

  return {
    format: FORMAT, releaseVersion, sourceDevelopCommit, observedAt: observedAt.text, chainId: evidence.chain.chainId,
    genesisHash, capacityVault, threadProofCharter,
    registrations: {
      capacitySpend: { proposalId: capacitySpend.proposalId, txHash: capacitySpend.txHash, circuitVersion: capacitySpend.circuitVersion },
      capacityRelease: { proposalId: capacityRelease.proposalId, txHash: capacityRelease.txHash, circuitVersion: capacityRelease.circuitVersion },
    },
  };
}

export const PRODUCTION_VERIFIER_GOVERNANCE_EVIDENCE_FORMAT = FORMAT;
