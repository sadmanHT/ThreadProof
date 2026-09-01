import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { keccak256 } from "ethers";

const PINNED_CIRCOM_REVISION = "9fd40a34f42912ee52230f8b6a114d78f6df1a48";
const REQUIRED_PNPM_VERSION = "10.15.0";
const DEPENDENCY_INSTALL_METHOD = "pnpm-offline-frozen-lockfile";
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const ALLOWED_ARGUMENTS = new Set([
  "circuit",
  "r1cs",
  "verification-key",
  "verifier-sol",
  "ceremony-evidence",
  "out-dir",
]);

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Unsupported argument --${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed.set(key, value);
    i += 1;
  }
  return parsed;
}

function required(args, key) {
  const value = args.get(key)?.trim();
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function sha256Bytes(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireHash32(value, label) {
  if (typeof value !== "string" || !HASH32.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${label} must be a non-zero 32-byte 0x-prefixed hash`);
  }
  return value.toLowerCase();
}

function requireEvidenceHash(actualBytes, evidenceArtifact, label) {
  if (!evidenceArtifact || typeof evidenceArtifact.sha256 !== "string") {
    throw new Error(`Ceremony evidence is missing ${label}.sha256`);
  }
  const actual = sha256Bytes(actualBytes);
  if (actual.toLowerCase() !== evidenceArtifact.sha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 does not match the verified ceremony evidence`);
  }
}

const args = parseArgs(process.argv.slice(2));
const circuit = required(args, "circuit");
if (circuit !== "CapacitySpend" && circuit !== "CapacityRelease") {
  throw new Error("--circuit must be CapacitySpend or CapacityRelease");
}

const r1csPath = resolve(required(args, "r1cs"));
const verificationKeyPath = resolve(required(args, "verification-key"));
const verifierSolPath = resolve(required(args, "verifier-sol"));
const ceremonyEvidencePath = resolve(required(args, "ceremony-evidence"));
const outDir = resolve(required(args, "out-dir"));

const r1csBytes = readFileSync(r1csPath);
const verificationKeyBytes = readFileSync(verificationKeyPath);
const verifierBytes = readFileSync(verifierSolPath);
const evidenceBytes = readFileSync(ceremonyEvidencePath);
const evidence = JSON.parse(evidenceBytes.toString("utf8"));

if (evidence.format !== "threadproof-groth16-ceremony-evidence/v1" || evidence.schemaVersion !== 1) {
  throw new Error("Unsupported ThreadProof ceremony evidence format");
}
if (evidence.mode !== "production") {
  throw new Error("Production verifier wrappers require ceremony evidence with mode=production");
}
if (evidence.circuit !== circuit || evidence.circuitVersion !== 1) {
  throw new Error("Ceremony evidence circuit identity does not match the requested production wrapper");
}
if (!/^[0-9a-f]{40}$/i.test(evidence.sourceCommit ?? "") || /^0{40}$/i.test(evidence.sourceCommit ?? "")) {
  throw new Error("Ceremony evidence is not bound to a non-zero exact canonical source commit");
}
if (
  evidence.verification?.circuitBuildRecompiled !== true ||
  evidence.verification?.sourceCommitMatchedCleanGitHead !== true ||
  evidence.verification?.dependenciesRehydratedFromFrozenLockfile !== true ||
  evidence.verification?.repositoryNodeModulesIgnored !== true
) {
  throw new Error(
    "Production verifier wrappers require ceremony evidence from an exact clean-source compilation using frozen-lockfile rehydrated dependencies",
  );
}
if (
  !Number.isSafeInteger(evidence.verification?.phase2ContributionCount) ||
  evidence.verification.phase2ContributionCount < 2 ||
  !Number.isSafeInteger(evidence.verification?.minimumPhase2ContributionCount) ||
  evidence.verification.minimumPhase2ContributionCount < 2
) {
  throw new Error("Production ceremony evidence must enforce and prove at least two Phase-2 contributions");
}
if (
  evidence.handling?.participantEntropyAcceptedByThisTool !== false ||
  evidence.handling?.participantPrivateMaterialPersistedByThisTool !== false
) {
  throw new Error("Ceremony evidence does not preserve the ThreadProof participant-secret boundary");
}
if (evidence.build?.compilerPinnedSourceRevision !== PINNED_CIRCOM_REVISION) {
  throw new Error("Ceremony evidence was not built with the pinned ThreadProof Circom source revision");
}
if (
  evidence.build?.dependencyInstallMethod !== DEPENDENCY_INSTALL_METHOD ||
  evidence.build?.pnpmVersion !== REQUIRED_PNPM_VERSION
) {
  throw new Error("Ceremony evidence was not built from ThreadProof's offline frozen-lockfile dependency boundary");
}
const buildAttestationSha256 = requireHash32(
  evidence.artifacts?.buildAttestation?.sha256,
  "build attestation SHA-256",
);
const compilerBinarySha256 = requireHash32(
  evidence.build?.compilerBinarySha256,
  "compiler binary SHA-256",
);
const pnpmExecutableSha256 = requireHash32(
  evidence.build?.pnpmExecutableSha256,
  "pnpm executable SHA-256",
);

requireEvidenceHash(r1csBytes, evidence.artifacts?.r1cs, "R1CS");
requireEvidenceHash(verificationKeyBytes, evidence.artifacts?.verificationKey, "verification key");
requireEvidenceHash(verifierBytes, evidence.artifacts?.solidityVerifier, "Solidity verifier");

const originalVerifierSource = verifierBytes.toString("utf8");
const contractNames = [
  ...originalVerifierSource.matchAll(/\bcontract\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g),
].map((match) => match[1]);
if (contractNames.length !== 1 || !contractNames[0] || !originalVerifierSource.includes("verifyProof")) {
  throw new Error("Expected exactly one generated Groth16 verifier contract exposing verifyProof");
}

const generatedVerifierContract = `${circuit}Groth16Verifier`;
const normalizedVerifierSource = originalVerifierSource.replace(
  new RegExp(`\\bcontract\\s+${contractNames[0]}\\s*\\{`),
  `contract ${generatedVerifierContract} {`,
);
if (normalizedVerifierSource === originalVerifierSource) {
  throw new Error("Failed to normalize the generated verifier contract name");
}

mkdirSync(outDir, { recursive: true });
const verifierOutputPath = join(outDir, `${circuit}Verifier.sol`);
const wrapperOutputPath = join(outDir, `${circuit}VerifierWithProvenance.sol`);
const provenanceOutputPath = join(outDir, `${circuit}_production_verifier_provenance.json`);
writeFileSync(verifierOutputPath, normalizedVerifierSource, { mode: 0o644 });

const circuitArtifactHash = keccak256(r1csBytes);
const verificationKeyHash = keccak256(verificationKeyBytes);
const ceremonyEvidenceSha256 = sha256Bytes(evidenceBytes);
const wrapperContract = `${circuit}VerifierWithProvenance`;
const wrapperSource = `// SPDX-License-Identifier: GPL-3.0\npragma solidity ^0.8.28;\n\nimport {${generatedVerifierContract}} from "./${circuit}Verifier.sol";\n\n/// @notice Production Groth16 verifier bound to exact circuit build and ceremony provenance.\n/// @dev The proof verifier is inherited directly so the deployed runtime is self-contained and reproducible.\ncontract ${wrapperContract} is ${generatedVerifierContract} {\n    bytes32 public constant circuitArtifactHash = ${circuitArtifactHash};\n    bytes32 public constant verificationKeyHash = ${verificationKeyHash};\n    bytes32 public constant buildAttestationSha256 = ${buildAttestationSha256};\n    bytes32 public constant ceremonyEvidenceSha256 = ${ceremonyEvidenceSha256};\n}\n`;
writeFileSync(wrapperOutputPath, wrapperSource, { mode: 0o644 });

const provenance = {
  schemaVersion: 1,
  setup: "production-ceremony",
  productionTrustedSetup: true,
  circuitBuildRecompiled: true,
  dependenciesRehydratedFromFrozenLockfile: true,
  repositoryNodeModulesIgnored: true,
  verifierComposition: "direct-inheritance",
  circuit,
  circuitVersion: 1,
  sourceCommit: evidence.sourceCommit,
  ceremonyId: evidence.ceremonyId,
  phase2ContributionCount: evidence.verification.phase2ContributionCount,
  minimumPhase2ContributionCount: evidence.verification.minimumPhase2ContributionCount,
  build: {
    attestationSha256: buildAttestationSha256,
    gitTree: evidence.build?.gitTree,
    compilerVersion: evidence.build?.compilerVersion,
    compilerPinnedSourceRevision: evidence.build?.compilerPinnedSourceRevision,
    compilerBinarySha256,
    dependencyInstallMethod: evidence.build?.dependencyInstallMethod,
    pnpmVersion: evidence.build?.pnpmVersion,
    pnpmExecutableSha256,
    dependencyFileCount: evidence.build?.dependencyFileCount,
  },
  circuitArtifact: {
    filename: basename(r1csPath),
    keccak256: circuitArtifactHash,
    sha256: sha256Bytes(r1csBytes),
  },
  verificationKey: {
    filename: basename(verificationKeyPath),
    keccak256: verificationKeyHash,
    sha256: sha256Bytes(verificationKeyBytes),
  },
  ceremonyEvidence: {
    filename: basename(ceremonyEvidencePath),
    sha256: ceremonyEvidenceSha256,
  },
  generatedVerifierContract,
  wrapperContract,
  normalizedVerifierSourceSha256: sha256Bytes(Buffer.from(normalizedVerifierSource, "utf8")),
  wrapperSourceKeccak256: keccak256(Buffer.from(wrapperSource, "utf8")),
};
writeFileSync(provenanceOutputPath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });

console.log(
  `THREADPROOF_PRODUCTION_VERIFIER_PROVENANCE ${JSON.stringify({
    circuit,
    wrapperContract,
    circuitArtifactHash,
    verificationKeyHash,
    buildAttestationSha256,
    ceremonyEvidenceSha256,
    dependencyInstallMethod: provenance.build.dependencyInstallMethod,
    repositoryNodeModulesIgnored: true,
    verifierComposition: provenance.verifierComposition,
    verifierOutputPath,
    wrapperOutputPath,
    provenanceOutputPath,
  })}`,
);
