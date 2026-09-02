#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateProductionRecoveryEvidence,
  verifyReleaseBoundRecoveryBytes,
  verifyReleaseRecoveryEvidence,
} from "./verify-release-recovery-evidence.mjs";

const sourceCommit = "a".repeat(40);
const sha = (character) => character.repeat(64);
const workspace = mkdtempSync(path.join(tmpdir(), "threadproof-release-recovery-"));
const originalCwd = process.cwd();

const baseEvidence = {
  format: "threadproof-production-recovery-evidence/v1",
  generatedAt: "2026-09-03T00:00:00.000Z",
  sourceCommit,
  chainId: "2026",
  result: "pass",
  canonicalEventArchive: {
    sha256: sha("1"),
    eventCount: 5,
    governanceEventCount: 4,
    verifierEventCount: 1,
  },
  restoredReadModel: {
    sha256: sha("2"),
    governanceRows: 1,
    verifierRows: 1,
    semanticProjectionSha256: sha("3"),
  },
  privateBackup: {
    sourceTreeSha256: sha("4"),
    restoredTreeSha256: sha("4"),
    fileCount: 2,
    totalBytes: 128,
    byteIdentical: true,
  },
  assertions: [
    "restored governance projection equals deterministic canonical-event replay",
    "restored verifier provenance equals deterministic canonical-event replay",
    "restored private backup artifacts are byte-identical to the encrypted source backup",
  ],
  limitations: [
    "Private capacity openings are restored from encrypted backup material; they are not reconstructed from chain events.",
    "This evidence verifies recovery integrity and projection consistency; it does not prove the truth of physical-world audit inputs.",
  ],
};

function evidenceBytes(evidence = baseEvidence) {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function manifestFor(bytes = evidenceBytes(), overrides = {}) {
  const manifest = {
    release: {
      version: "v1.0.0",
      sourceDevelopCommit: sourceCommit,
      preparedAt: "2026-09-03T00:10:00.000Z",
    },
    chain: { chainId: 2026 },
    evidence: {
      backupRecoveryEvidenceUrl: "https://evidence.threadproof.invalid/v1.0.0/backup-recovery-evidence.json",
      backupRecoveryEvidenceSha256: digest(bytes),
    },
  };
  return {
    ...manifest,
    ...overrides,
    release: { ...manifest.release, ...(overrides.release ?? {}) },
    chain: { ...manifest.chain, ...(overrides.chain ?? {}) },
    evidence: { ...manifest.evidence, ...(overrides.evidence ?? {}) },
  };
}
function expectInvalid(evidence, expected, pattern) {
  assert.throws(() => validateProductionRecoveryEvidence(evidence, expected), pattern);
}

try {
  const validBytes = evidenceBytes();
  const validManifest = manifestFor(validBytes);
  const validExpected = {
    sourceDevelopCommit: sourceCommit,
    chainId: 2026,
    preparedAt: validManifest.release.preparedAt,
  };

  const summary = validateProductionRecoveryEvidence(structuredClone(baseEvidence), validExpected);
  assert.equal(summary.result, "pass");
  assert.equal(summary.sourceCommit, sourceCommit);
  assert.equal(summary.chainId, "2026");
  assert.equal(summary.privateBackupFiles, 2);

  const bound = verifyReleaseBoundRecoveryBytes(validManifest, validBytes, "fixture");
  assert.equal(bound.evidenceSha256, digest(validBytes));
  assert.equal(bound.sourceUrl, "fixture");

  const tamperedBytes = Buffer.concat([validBytes, Buffer.from(" \n")]);
  assert.throws(
    () => verifyReleaseBoundRecoveryBytes(validManifest, tamperedBytes, "tampered-fixture"),
    /does not match release manifest/i,
  );

  const wrongSource = structuredClone(baseEvidence);
  wrongSource.sourceCommit = "b".repeat(40);
  expectInvalid(wrongSource, validExpected, /sourceCommit does not match/i);

  const wrongChain = structuredClone(baseEvidence);
  wrongChain.chainId = "2027";
  expectInvalid(wrongChain, validExpected, /chainId does not match/i);

  const generatedAfterPreparation = structuredClone(baseEvidence);
  generatedAfterPreparation.generatedAt = "2026-09-03T00:11:00.000Z";
  expectInvalid(generatedAfterPreparation, validExpected, /must not be after release\.preparedAt/i);

  const nonPass = structuredClone(baseEvidence);
  nonPass.result = "incomplete";
  expectInvalid(nonPass, validExpected, /result must equal pass/i);

  const unknownField = structuredClone(baseEvidence);
  unknownField.operatorNote = "shadow metadata";
  expectInvalid(unknownField, validExpected, /unexpected field operatorNote/i);

  const secretField = structuredClone(baseEvidence);
  secretField.apiKey = "must-never-be-exported";
  expectInvalid(secretField, validExpected, /secret-bearing field name/i);

  const malformedHash = structuredClone(baseEvidence);
  malformedHash.canonicalEventArchive.sha256 = "not-a-hash";
  expectInvalid(malformedHash, validExpected, /64-character SHA-256/i);

  const mismatchedTree = structuredClone(baseEvidence);
  mismatchedTree.privateBackup.restoredTreeSha256 = sha("5");
  expectInvalid(mismatchedTree, validExpected, /tree digests must match/i);

  const notByteIdentical = structuredClone(baseEvidence);
  notByteIdentical.privateBackup.byteIdentical = false;
  expectInvalid(notByteIdentical, validExpected, /byteIdentical must be true/i);

  const impossibleCounts = structuredClone(baseEvidence);
  impossibleCounts.canonicalEventArchive.governanceEventCount = 5;
  impossibleCounts.canonicalEventArchive.verifierEventCount = 1;
  expectInvalid(impossibleCounts, validExpected, /cannot exceed eventCount/i);

  const credentialUrlManifest = manifestFor(validBytes, {
    evidence: {
      backupRecoveryEvidenceUrl: "https://operator:credential@evidence.threadproof.invalid/recovery.json",
    },
  });
  assert.throws(
    () => verifyReleaseBoundRecoveryBytes(credentialUrlManifest, validBytes, "fixture"),
    /must not contain URL credentials/i,
  );

  const releaseDir = path.join(workspace, "docs", "releases", "v1.0.0");
  mkdirSync(releaseDir, { recursive: true });
  const evidencePath = path.join(releaseDir, "backup-recovery-evidence.json");
  const manifestPath = path.join(workspace, "production-release.json");
  writeFileSync(evidencePath, validBytes);
  writeFileSync(manifestPath, `${JSON.stringify(validManifest, null, 2)}\n`);
  process.chdir(workspace);
  const fileSummary = await verifyReleaseRecoveryEvidence(manifestPath);
  assert.equal(fileSummary.evidenceSha256, digest(validBytes));
  assert.match(fileSummary.sourceUrl, /docs\/releases\/v1\.0\.0\/backup-recovery-evidence\.json/);

  const targetPath = path.join(workspace, "real-recovery-evidence.json");
  writeFileSync(targetPath, validBytes);
  unlinkSync(evidencePath);
  symlinkSync(targetPath, evidencePath);
  await assert.rejects(
    () => verifyReleaseRecoveryEvidence(manifestPath),
    /must not contain symbolic links/i,
  );

  console.log("Production release-bound backup/recovery evidence policy checks passed.");
} finally {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
}
