#!/usr/bin/env node

const HASH32 = /^0x[0-9a-f]{64}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLACEHOLDER = /(todo|tbd|placeholder|replace[-_ ]?me|example|dummy|changeme)/i;
const SECRET_KEY = /(password|passwd|secret|api[_-]?key|private[_-]?key|mnemonic|seed|token|credential|entropy)/i;
const SECRET_VALUE = /(-----BEGIN [^-\n]*PRIVATE KEY-----|\bxprv[0-9A-Za-z]+|\bmnemonic\s*[:=]|\bapi[_ -]?key\s*[:=]|\bpassword\s*[:=]|\bsecret\s*[:=])/i;
const SAFE_SECURITY_KEYS = new Set([
  "participantEntropyAcceptedByThisTool",
  "participantPrivateMaterialPersistedByThisTool",
]);
const EXPECTED_FORMAT = "threadproof-groth16-ceremony-evidence/v1";
const BUILD_FORMAT = "threadproof-circuit-build-attestation/v1";
const PINNED_CIRCOM_REVISION = "9fd40a34f42912ee52230f8b6a114d78f6df1a48";
const REQUIRED_CIRCOM_VERSION = "2.2.0";
const DEPENDENCY_INSTALL_METHOD = "pnpm-offline-frozen-lockfile";
const REQUIRED_PNPM_VERSION = "10.15.0";

function fail(message) {
  throw new Error(`Production ceremony evidence validation failed: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(record, expected, label) {
  requireValue(isRecord(record), `${label} must be an object.`);
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  requireValue(
    actual.length === required.length && actual.every((key, index) => key === required[index]),
    `${label} must contain exactly: ${required.join(", ")}.`,
  );
}
function cleanText(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  const text = value.trim();
  requireValue(!PLACEHOLDER.test(text), `${label} contains placeholder text.`);
  requireValue(!SECRET_VALUE.test(text), `${label} contains secret-bearing material.`);
  return text;
}
function requireHash32(value, label) {
  requireValue(typeof value === "string" && HASH32.test(value), `${label} must be a 0x-prefixed 32-byte hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function requireGitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function requireIso(value, label) {
  const text = cleanText(value, label);
  requireValue(Number.isFinite(Date.parse(text)), `${label} must be an ISO-8601 timestamp.`);
  return text;
}
function assertNoSensitiveMaterial(value, path = "evidence") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertNoSensitiveMaterial(value[i], `${path}[${i}]`);
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string") {
      requireValue(!SECRET_VALUE.test(value), `${path} contains secret-bearing material.`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    requireValue(
      SAFE_SECURITY_KEYS.has(key) || !SECRET_KEY.test(key),
      `${path}.${key} uses a secret-bearing field name.`,
    );
    assertNoSensitiveMaterial(child, `${path}.${key}`);
  }
}
function validateArtifact(value, label) {
  exactKeys(value, ["filename", "sizeBytes", "sha256"], label);
  const filename = cleanText(value.filename, `${label}.filename`);
  requireValue(!filename.includes("/") && !filename.includes("\\") && filename !== "." && filename !== "..", `${label}.filename must be a basename only.`);
  requireValue(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0, `${label}.sizeBytes must be a positive safe integer.`);
  const sha256 = requireHash32(value.sha256, `${label}.sha256`);
  return { filename, sizeBytes: value.sizeBytes, sha256 };
}

export function validateProductionCeremonyEvidence(evidence, expected) {
  requireValue(isRecord(expected), "expected release binding is required.");
  assertNoSensitiveMaterial(evidence);
  exactKeys(evidence, [
    "schemaVersion", "format", "mode", "circuit", "circuitVersion", "ceremonyId", "sourceCommit",
    "verification", "build", "artifacts", "tooling", "generatedAt", "handling",
  ], "evidence");

  requireValue(evidence.schemaVersion === 1, "schemaVersion must equal 1.");
  requireValue(evidence.format === EXPECTED_FORMAT, `format must equal ${EXPECTED_FORMAT}.`);
  requireValue(evidence.mode === "production", "mode must equal production.");
  requireValue(evidence.circuit === expected.circuit, `circuit must equal ${expected.circuit}.`);
  requireValue(evidence.circuitVersion === expected.circuitVersion, `circuitVersion must equal ${expected.circuitVersion}.`);
  const ceremonyId = cleanText(evidence.ceremonyId, "ceremonyId");
  requireValue(ceremonyId !== "ci-validation", "ceremonyId must not use the CI-validation identity.");
  const sourceCommit = requireGitSha(evidence.sourceCommit, "sourceCommit");
  const expectedSourceCommit = requireGitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit");
  requireValue(sourceCommit === expectedSourceCommit, "sourceCommit does not match release.sourceDevelopCommit.");

  exactKeys(evidence.verification, [
    "circuitBuildRecompiled", "sourceCommitMatchedCleanGitHead", "dependenciesRehydratedFromFrozenLockfile",
    "repositoryNodeModulesIgnored", "powersOfTauVerified", "finalZkeyVerified", "phase2ContributionCount",
    "minimumPhase2ContributionCount",
  ], "verification");
  for (const key of [
    "circuitBuildRecompiled", "sourceCommitMatchedCleanGitHead", "dependenciesRehydratedFromFrozenLockfile",
    "repositoryNodeModulesIgnored", "powersOfTauVerified", "finalZkeyVerified",
  ]) {
    requireValue(evidence.verification[key] === true, `verification.${key} must be true.`);
  }
  requireValue(
    Number.isSafeInteger(evidence.verification.phase2ContributionCount) && evidence.verification.phase2ContributionCount >= 2,
    "verification.phase2ContributionCount must be at least 2 in production.",
  );
  requireValue(
    Number.isSafeInteger(evidence.verification.minimumPhase2ContributionCount) && evidence.verification.minimumPhase2ContributionCount >= 2,
    "verification.minimumPhase2ContributionCount must be at least 2 in production.",
  );
  requireValue(
    evidence.verification.phase2ContributionCount >= evidence.verification.minimumPhase2ContributionCount,
    "verified Phase-2 contribution count is below the recorded production minimum.",
  );

  exactKeys(evidence.build, [
    "format", "gitTree", "compilerVersion", "compilerPinnedSourceRevision", "compilerBinarySha256",
    "dependencyInstallMethod", "pnpmVersion", "pnpmExecutableSha256", "dependencyFileCount",
  ], "build");
  requireValue(evidence.build.format === BUILD_FORMAT, `build.format must equal ${BUILD_FORMAT}.`);
  requireGitSha(evidence.build.gitTree, "build.gitTree");
  requireValue(evidence.build.compilerVersion === REQUIRED_CIRCOM_VERSION, `build.compilerVersion must equal ${REQUIRED_CIRCOM_VERSION}.`);
  requireValue(evidence.build.compilerPinnedSourceRevision === PINNED_CIRCOM_REVISION, "build.compilerPinnedSourceRevision does not match ThreadProof's pinned Circom source revision.");
  requireHash32(evidence.build.compilerBinarySha256, "build.compilerBinarySha256");
  requireValue(evidence.build.dependencyInstallMethod === DEPENDENCY_INSTALL_METHOD, `build.dependencyInstallMethod must equal ${DEPENDENCY_INSTALL_METHOD}.`);
  requireValue(evidence.build.pnpmVersion === REQUIRED_PNPM_VERSION, `build.pnpmVersion must equal ${REQUIRED_PNPM_VERSION}.`);
  requireHash32(evidence.build.pnpmExecutableSha256, "build.pnpmExecutableSha256");
  requireValue(Number.isSafeInteger(evidence.build.dependencyFileCount) && evidence.build.dependencyFileCount > 0, "build.dependencyFileCount must be positive.");

  exactKeys(evidence.artifacts, ["buildAttestation", "r1cs", "powersOfTau", "finalZkey", "verificationKey", "solidityVerifier"], "artifacts");
  const artifacts = {};
  for (const key of ["buildAttestation", "r1cs", "powersOfTau", "finalZkey", "verificationKey", "solidityVerifier"]) {
    artifacts[key] = validateArtifact(evidence.artifacts[key], `artifacts.${key}`);
  }
  const expectedBuildAttestationSha256 = requireHash32(expected.buildAttestationSha256, "expected buildAttestationSha256");
  requireValue(
    artifacts.buildAttestation.sha256 === expectedBuildAttestationSha256,
    "artifacts.buildAttestation.sha256 does not match the release verifier buildAttestationSha256.",
  );

  exactKeys(evidence.tooling, ["snarkjsVersion"], "tooling");
  const snarkjsVersion = cleanText(evidence.tooling.snarkjsVersion, "tooling.snarkjsVersion");
  requireValue(VERSION.test(snarkjsVersion), "tooling.snarkjsVersion must be semantic version text.");

  const generatedAt = requireIso(evidence.generatedAt, "generatedAt");
  const preparedAt = requireIso(expected.preparedAt, "expected preparedAt");
  requireValue(Date.parse(generatedAt) <= Date.parse(preparedAt), "generatedAt must not be after release.preparedAt.");

  exactKeys(evidence.handling, [
    "participantEntropyAcceptedByThisTool", "participantPrivateMaterialPersistedByThisTool", "finalZkeyCopiedByThisTool", "note",
  ], "handling");
  requireValue(evidence.handling.participantEntropyAcceptedByThisTool === false, "handling.participantEntropyAcceptedByThisTool must be false.");
  requireValue(evidence.handling.participantPrivateMaterialPersistedByThisTool === false, "handling.participantPrivateMaterialPersistedByThisTool must be false.");
  requireValue(evidence.handling.finalZkeyCopiedByThisTool === false, "handling.finalZkeyCopiedByThisTool must be false.");
  cleanText(evidence.handling.note, "handling.note");

  return {
    format: evidence.format,
    circuit: evidence.circuit,
    circuitVersion: evidence.circuitVersion,
    ceremonyId,
    sourceCommit,
    generatedAt,
    phase2ContributionCount: evidence.verification.phase2ContributionCount,
    minimumPhase2ContributionCount: evidence.verification.minimumPhase2ContributionCount,
    buildAttestationSha256: artifacts.buildAttestation.sha256,
  };
}
