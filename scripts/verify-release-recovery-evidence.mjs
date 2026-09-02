#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RECOVERY_FORMAT = "threadproof-production-recovery-evidence/v1";
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_ASSERTIONS = [
  "restored governance projection equals deterministic canonical-event replay",
  "restored verifier provenance equals deterministic canonical-event replay",
  "restored private backup artifacts are byte-identical to the encrypted source backup",
];
const SAFE_LIMITATIONS = [
  "Private capacity openings are restored from encrypted backup material; they are not reconstructed from chain events.",
  "This evidence verifies recovery integrity and projection consistency; it does not prove the truth of physical-world audit inputs.",
];
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "password",
  "passwordvalue",
  "privatekey",
  "privatekeypem",
  "mnemonic",
  "seedphrase",
  "accesstoken",
  "refreshtoken",
  "servicerolekey",
  "apikey",
  "clientsecret",
  "bearer",
  "authorizationheader",
]);
const FORBIDDEN_VALUE = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|seed phrase|mnemonic phrase|bearer\s+[A-Za-z0-9._-]{12,})/i;

function fail(message) {
  throw new Error(`Release backup/recovery evidence verification failed: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function exactKeys(record, keys, label) {
  requireValue(isRecord(record), `${label} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    requireValue(allowed.has(key), `${label} contains unexpected field ${key}.`);
  }
  for (const key of keys) {
    requireValue(Object.prototype.hasOwnProperty.call(record, key), `${label}.${key} is required.`);
  }
}
function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function scanUnsafe(value, label = "recovery evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanUnsafe(entry, `${label}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey(key)), `${label}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${label}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    requireValue(!FORBIDDEN_VALUE.test(value), `${label} appears to contain secret material.`);
    if (value.includes("://")) {
      try {
        const parsed = new URL(value);
        requireValue(!parsed.username && !parsed.password, `${label} contains a credential-bearing URL.`);
      } catch {
        // Owning schema fields validate their own text. Recovery evidence currently has no URL fields.
      }
    }
  }
}
function sha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function gitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function integer(value, label, { min = 0 } = {}) {
  requireValue(Number.isSafeInteger(value) && value >= min, `${label} must be an integer >= ${min}.`);
  return value;
}
function isoDate(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  const millis = Date.parse(value);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text: value, millis };
}
function httpsUrl(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(parsed.protocol === "https:", `${label} must use https.`);
  requireValue(!parsed.username && !parsed.password, `${label} must not contain URL credentials.`);
  return parsed.toString();
}
function exactStringArray(value, expected, label) {
  requireValue(Array.isArray(value), `${label} must be an array.`);
  requireValue(value.length === expected.length, `${label} must contain exactly ${expected.length} entries.`);
  for (let index = 0; index < expected.length; index += 1) {
    requireValue(value[index] === expected[index], `${label}[${index}] does not match the canonical recovery evidence statement.`);
  }
}

export function validateProductionRecoveryEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  exactKeys(
    evidence,
    [
      "format",
      "generatedAt",
      "sourceCommit",
      "chainId",
      "result",
      "canonicalEventArchive",
      "restoredReadModel",
      "privateBackup",
      "assertions",
      "limitations",
    ],
    "recovery evidence",
  );
  requireValue(evidence.format === RECOVERY_FORMAT, `format must equal ${RECOVERY_FORMAT}.`);
  requireValue(evidence.result === "pass", "result must equal pass.");

  const generatedAt = isoDate(evidence.generatedAt, "generatedAt");
  const sourceCommit = gitSha(evidence.sourceCommit, "sourceCommit");
  requireValue(typeof evidence.chainId === "string" && /^[0-9]+$/.test(evidence.chainId), "chainId must be a decimal string.");
  const chainId = BigInt(evidence.chainId).toString(10);

  if (expected.sourceDevelopCommit !== undefined) {
    requireValue(sourceCommit === gitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceCommit does not match the release sourceDevelopCommit.");
  }
  if (expected.chainId !== undefined) {
    requireValue(chainId === BigInt(expected.chainId).toString(10), "chainId does not match the release manifest.");
  }
  if (expected.preparedAt !== undefined) {
    const preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(generatedAt.millis <= preparedAt.millis, "generatedAt must not be after release.preparedAt.");
  }

  const archive = evidence.canonicalEventArchive;
  exactKeys(archive, ["sha256", "eventCount", "governanceEventCount", "verifierEventCount"], "canonicalEventArchive");
  sha256(archive.sha256, "canonicalEventArchive.sha256");
  const eventCount = integer(archive.eventCount, "canonicalEventArchive.eventCount", { min: 1 });
  const governanceEventCount = integer(archive.governanceEventCount, "canonicalEventArchive.governanceEventCount");
  const verifierEventCount = integer(archive.verifierEventCount, "canonicalEventArchive.verifierEventCount");
  requireValue(governanceEventCount + verifierEventCount <= eventCount, "relevant canonical event counts cannot exceed eventCount.");

  const restored = evidence.restoredReadModel;
  exactKeys(restored, ["sha256", "governanceRows", "verifierRows", "semanticProjectionSha256"], "restoredReadModel");
  sha256(restored.sha256, "restoredReadModel.sha256");
  integer(restored.governanceRows, "restoredReadModel.governanceRows");
  integer(restored.verifierRows, "restoredReadModel.verifierRows");
  sha256(restored.semanticProjectionSha256, "restoredReadModel.semanticProjectionSha256");

  const backup = evidence.privateBackup;
  exactKeys(backup, ["sourceTreeSha256", "restoredTreeSha256", "fileCount", "totalBytes", "byteIdentical"], "privateBackup");
  const sourceTreeSha256 = sha256(backup.sourceTreeSha256, "privateBackup.sourceTreeSha256");
  const restoredTreeSha256 = sha256(backup.restoredTreeSha256, "privateBackup.restoredTreeSha256");
  requireValue(sourceTreeSha256 === restoredTreeSha256, "private backup source/restored tree digests must match.");
  integer(backup.fileCount, "privateBackup.fileCount", { min: 1 });
  integer(backup.totalBytes, "privateBackup.totalBytes");
  requireValue(backup.byteIdentical === true, "privateBackup.byteIdentical must be true.");

  exactStringArray(evidence.assertions, SAFE_ASSERTIONS, "assertions");
  exactStringArray(evidence.limitations, SAFE_LIMITATIONS, "limitations");

  return {
    format: evidence.format,
    result: evidence.result,
    generatedAt: generatedAt.text,
    sourceCommit,
    chainId,
    eventCount,
    privateBackupFiles: backup.fileCount,
    privateBackupTreeSha256: sourceTreeSha256,
  };
}

function releaseExpectations(manifest) {
  requireValue(isRecord(manifest?.release), "release manifest release section is required.");
  requireValue(isRecord(manifest?.chain), "release manifest chain section is required.");
  requireValue(isRecord(manifest?.evidence), "release manifest evidence section is required.");

  const releaseVersion = String(manifest.release.version ?? "").trim();
  requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
  const expectedSha = String(manifest.evidence.backupRecoveryEvidenceSha256 ?? "").toLowerCase();
  requireValue(SHA256.test(expectedSha) && !/^0{64}$/.test(expectedSha), "evidence.backupRecoveryEvidenceSha256 must be a non-zero 64-character SHA-256 digest.");
  const evidenceUrl = httpsUrl(manifest.evidence.backupRecoveryEvidenceUrl, "evidence.backupRecoveryEvidenceUrl");

  return {
    releaseVersion,
    expectedSha,
    evidenceUrl,
    expected: {
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      chainId: manifest.chain.chainId,
      preparedAt: manifest.release.preparedAt,
    },
  };
}

export function verifyReleaseBoundRecoveryBytes(manifest, bytes, sourceUrl = "local-release-evidence") {
  const { expectedSha, expected } = releaseExpectations(manifest);
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "backup/recovery evidence bytes are required.");
  requireValue(bytes.byteLength > 0, "backup/recovery evidence is empty.");
  requireValue(bytes.byteLength <= MAX_EVIDENCE_BYTES, `backup/recovery evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actualSha = sha256Hex(bytes);
  requireValue(actualSha === expectedSha, `backup/recovery evidence sha256 ${actualSha} does not match release manifest ${expectedSha}.`);

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateProductionRecoveryEvidence(evidence, expected);
  return { ...summary, evidenceSha256: actualSha, sourceUrl };
}

async function assertNoSymlinkPath(root, filePath) {
  const relative = path.relative(root, filePath);
  requireValue(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), "backup/recovery evidence path escapes the repository checkout.");
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); } catch {
      fail(`required backup/recovery evidence path component is missing: ${path.relative(root, cursor)}.`);
    }
    requireValue(!metadata.isSymbolicLink(), `backup/recovery evidence path must not contain symbolic links: ${path.relative(root, cursor)}.`);
  }
}

export async function verifyReleaseRecoveryEvidence(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { releaseVersion, evidenceUrl } = releaseExpectations(manifest);
  const root = path.resolve(process.cwd());
  const evidenceRelativePath = `docs/releases/${releaseVersion}/backup-recovery-evidence.json`;
  const evidencePath = path.resolve(root, evidenceRelativePath);
  requireValue(evidencePath.startsWith(`${path.join(root, "docs", "releases")}${path.sep}`), "derived backup/recovery evidence path escapes docs/releases.");
  await assertNoSymlinkPath(root, evidencePath);
  const metadata = await lstat(evidencePath);
  requireValue(metadata.isFile(), `${evidenceRelativePath} must be a regular file.`);
  requireValue(metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES, `${evidenceRelativePath} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes.`);
  const bytes = await readFile(evidencePath);
  return verifyReleaseBoundRecoveryBytes(manifest, bytes, `${evidenceRelativePath} (archive: ${evidenceUrl})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(process.cwd(), process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json");
  verifyReleaseRecoveryEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production backup/recovery evidence verified: ${JSON.stringify(summary)}`);
    console.log("Scope: this gate verifies exact committed evidence bytes, release/source/chain binding, and sanitized recovery assertions; it does not create backups or prove external operator custody or honesty.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
