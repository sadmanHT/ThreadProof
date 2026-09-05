#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  verifyReleaseBoundCeremonyBytes,
  verifyReleaseCeremonyEvidence,
} from "./verify-release-ceremony-evidence.mjs";

const SOURCE = "e96cf8785a96b532616fd9759fbaf05792d2b3d6";
const BUILD_SPEND = `0x${"11".repeat(32)}`;
const BUILD_RELEASE = `0x${"22".repeat(32)}`;
const GENERATED_AT = "2026-09-03T01:00:00.000Z";
const PREPARED_AT = "2026-09-03T02:00:00.000Z";
const HASH = (byte) => `0x${byte.repeat(64)}`;

function sha256Hash32(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function clone(value) {
  return structuredClone(value);
}
function artifact(filename, byte) {
  return { filename, sizeBytes: 1234, sha256: HASH(byte) };
}
function makeEvidence(circuit, buildAttestationSha256) {
  return {
    schemaVersion: 1,
    format: "threadproof-groth16-ceremony-evidence/v1",
    mode: "production",
    circuit,
    circuitVersion: 1,
    ceremonyId: `THREADPROOF-${circuit.toUpperCase()}-2026`,
    sourceCommit: SOURCE,
    verification: {
      circuitBuildRecompiled: true,
      sourceCommitMatchedCleanGitHead: true,
      dependenciesRehydratedFromFrozenLockfile: true,
      repositoryNodeModulesIgnored: true,
      powersOfTauVerified: true,
      finalZkeyVerified: true,
      phase2ContributionCount: 3,
      minimumPhase2ContributionCount: 2,
    },
    build: {
      format: "threadproof-circuit-build-attestation/v1",
      gitTree: "3333333333333333333333333333333333333333",
      compilerVersion: "2.2.0",
      compilerPinnedSourceRevision: "9fd40a34f42912ee52230f8b6a114d78f6df1a48",
      compilerBinarySha256: HASH("4"),
      dependencyInstallMethod: "pnpm-offline-frozen-lockfile",
      pnpmVersion: "10.15.0",
      pnpmExecutableSha256: HASH("5"),
      dependencyFileCount: 17,
    },
    artifacts: {
      buildAttestation: artifact(`${circuit}_build_attestation.json`, buildAttestationSha256.slice(2, 3)),
      r1cs: artifact(`${circuit}.r1cs`, "6"),
      powersOfTau: artifact("powersOfTau28_hez_final_21.ptau", "7"),
      finalZkey: artifact(`${circuit}_final.zkey`, "8"),
      verificationKey: artifact(`${circuit}_verification_key.json`, "9"),
      solidityVerifier: artifact(`${circuit}Verifier.sol`, "a"),
    },
    tooling: { snarkjsVersion: "0.7.5" },
    generatedAt: GENERATED_AT,
    handling: {
      participantEntropyAcceptedByThisTool: false,
      participantPrivateMaterialPersistedByThisTool: false,
      finalZkeyCopiedByThisTool: false,
      note: "Verifier consumes finalized ceremony artifacts only; contributions are created outside this repository workflow.",
    },
  };
}

const spendEvidence = makeEvidence("CapacitySpend", BUILD_SPEND);
spendEvidence.artifacts.buildAttestation.sha256 = BUILD_SPEND;
const releaseEvidence = makeEvidence("CapacityRelease", BUILD_RELEASE);
releaseEvidence.artifacts.buildAttestation.sha256 = BUILD_RELEASE;
const spendBytes = bytes(spendEvidence);
const releaseBytes = bytes(releaseEvidence);

function makeManifest(spend = spendBytes, release = releaseBytes) {
  return {
    schemaVersion: 1,
    release: {
      version: "v1.0.0",
      sourceDevelopCommit: SOURCE,
      preparedAt: PREPARED_AT,
      preparedBy: "operator-1",
    },
    verifiers: {
      capacitySpend: {
        circuitVersion: 1,
        setup: "production-ceremony",
        buildAttestationSha256: BUILD_SPEND,
        ceremonyEvidenceUrl: "https://evidence.invalid/threadproof/v1.0.0/capacity-spend-ceremony-evidence.json",
        ceremonyEvidenceSha256: sha256Hash32(spend),
      },
      capacityRelease: {
        circuitVersion: 1,
        setup: "production-ceremony",
        buildAttestationSha256: BUILD_RELEASE,
        ceremonyEvidenceUrl: "https://evidence.invalid/threadproof/v1.0.0/capacity-release-ceremony-evidence.json",
        ceremonyEvidenceSha256: sha256Hash32(release),
      },
    },
  };
}

function expectReject(label, fn, fragment) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(fragment)) throw new Error(`${label} rejected for the wrong reason: ${message}`);
    return;
  }
  throw new Error(`${label} unexpectedly passed.`);
}

function semanticCase(label, mutate, fragment) {
  const evidence = clone(spendEvidence);
  mutate(evidence);
  const evidenceBytes = bytes(evidence);
  const manifest = makeManifest(evidenceBytes, releaseBytes);
  expectReject(label, () => verifyReleaseBoundCeremonyBytes(manifest, "capacitySpend", evidenceBytes), fragment);
}

const positiveManifest = makeManifest();
const spendSummary = verifyReleaseBoundCeremonyBytes(positiveManifest, "capacitySpend", spendBytes);
const releaseSummary = verifyReleaseBoundCeremonyBytes(positiveManifest, "capacityRelease", releaseBytes);
if (spendSummary.circuit !== "CapacitySpend" || releaseSummary.circuit !== "CapacityRelease") {
  throw new Error("Positive ceremony evidence did not return both circuit identities.");
}

expectReject(
  "exact-byte tamper",
  () => verifyReleaseBoundCeremonyBytes(positiveManifest, "capacitySpend", Buffer.concat([spendBytes, Buffer.from(" ")])),
  "does not match release manifest",
);
const rawDigestManifest = makeManifest();
rawDigestManifest.verifiers.capacitySpend.ceremonyEvidenceSha256 = rawDigestManifest.verifiers.capacitySpend.ceremonyEvidenceSha256.slice(2);
expectReject(
  "raw digest encoding",
  () => verifyReleaseBoundCeremonyBytes(rawDigestManifest, "capacitySpend", spendBytes),
  "must be a 0x-prefixed 32-byte hash",
);
semanticCase("CI-validation ceremony", (e) => { e.mode = "ci-validation"; }, "mode must equal production");
semanticCase("wrong circuit", (e) => { e.circuit = "CapacityRelease"; }, "circuit must equal CapacitySpend");
semanticCase("wrong source", (e) => { e.sourceCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }, "does not match release.sourceDevelopCommit");
semanticCase("powers of tau not verified", (e) => { e.verification.powersOfTauVerified = false; }, "powersOfTauVerified must be true");
semanticCase("final zkey not verified", (e) => { e.verification.finalZkeyVerified = false; }, "finalZkeyVerified must be true");
semanticCase("one contribution", (e) => { e.verification.phase2ContributionCount = 1; }, "phase2ContributionCount must be at least 2");
semanticCase("minimum below production floor", (e) => { e.verification.minimumPhase2ContributionCount = 1; }, "minimumPhase2ContributionCount must be at least 2");
semanticCase("verified count below minimum", (e) => { e.verification.minimumPhase2ContributionCount = 4; }, "below the recorded production minimum");
semanticCase("build attestation mismatch", (e) => { e.artifacts.buildAttestation.sha256 = HASH("b"); }, "does not match the release verifier buildAttestationSha256");
semanticCase("participant entropy accepted", (e) => { e.handling.participantEntropyAcceptedByThisTool = true; }, "participantEntropyAcceptedByThisTool must be false");
semanticCase("participant private material persisted", (e) => { e.handling.participantPrivateMaterialPersistedByThisTool = true; }, "participantPrivateMaterialPersistedByThisTool must be false");
semanticCase("placeholder ceremony id", (e) => { e.ceremonyId = "REPLACE_ME"; }, "contains placeholder text");
semanticCase("late generation", (e) => { e.generatedAt = "2026-09-03T03:00:00.000Z"; }, "must not be after release.preparedAt");
semanticCase("secret-bearing value", (e) => { e.handling.note = "password=do-not-store"; }, "secret-bearing material");
semanticCase("unknown secret field", (e) => { e.apiKey = "not-allowed"; }, "secret-bearing field name");
semanticCase("unknown ordinary field", (e) => { e.unexpected = true; }, "must contain exactly");

const malformed = Buffer.from("{not-json}\n", "utf8");
const malformedManifest = makeManifest(malformed, releaseBytes);
expectReject(
  "malformed JSON",
  () => verifyReleaseBoundCeremonyBytes(malformedManifest, "capacitySpend", malformed),
  "is not valid JSON",
);
expectReject(
  "oversized evidence",
  () => verifyReleaseBoundCeremonyBytes(positiveManifest, "capacitySpend", Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)),
  "exceeds",
);
const pathEscapeManifest = makeManifest();
pathEscapeManifest.release.version = "../escape";
expectReject(
  "path escape version",
  () => verifyReleaseBoundCeremonyBytes(pathEscapeManifest, "capacitySpend", spendBytes),
  "release.version must be a semantic version",
);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "threadproof-ceremony-release-"));
try {
  const releaseDir = path.join(tempRoot, "release");
  const evidenceDir = path.join(tempRoot, "docs", "releases", "v1.0.0");
  await mkdir(releaseDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const manifestPath = path.join(releaseDir, "production-release.json");
  await writeFile(manifestPath, `${JSON.stringify(positiveManifest, null, 2)}\n`, "utf8");
  const spendPath = path.join(evidenceDir, "capacity-spend-ceremony-evidence.json");
  const releasePath = path.join(evidenceDir, "capacity-release-ceremony-evidence.json");
  await writeFile(spendPath, spendBytes);
  await writeFile(releasePath, releaseBytes);
  const summaries = await verifyReleaseCeremonyEvidence(manifestPath, tempRoot);
  if (Object.keys(summaries).length !== 2) throw new Error("Filesystem verification did not return both ceremony summaries.");

  const symlinkTarget = path.join(tempRoot, "spend-target.json");
  await writeFile(symlinkTarget, spendBytes);
  await unlink(spendPath);
  await symlink(symlinkTarget, spendPath);
  try {
    await verifyReleaseCeremonyEvidence(manifestPath, tempRoot);
    throw new Error("symlink evidence unexpectedly passed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("must not contain symbolic links")) throw error;
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Release-bound production ceremony evidence tests passed.");
