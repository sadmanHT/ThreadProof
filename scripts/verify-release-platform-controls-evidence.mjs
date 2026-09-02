#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionPlatformControlsEvidence } from "./production-platform-controls-evidence.mjs";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`Release platform-controls evidence verification failed: ${message}`);
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
function requireHttpsUrl(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  requireValue(!url.username && !url.password, `${label} must not contain URL credentials.`);
  return url.toString();
}

function releaseExpectations(manifest) {
  requireValue(isRecord(manifest?.release), "release manifest release section is required.");
  requireValue(isRecord(manifest?.evidence), "release manifest evidence section is required.");
  requireValue(isRecord(manifest?.externalControls), "release manifest externalControls section is required.");

  const releaseVersion = String(manifest.release.version ?? "").trim();
  requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
  const expectedSha = String(manifest.evidence.platformControlsEvidenceSha256 ?? "").toLowerCase();
  requireValue(SHA256.test(expectedSha) && !/^0{64}$/.test(expectedSha), "evidence.platformControlsEvidenceSha256 must be a non-zero 64-character SHA-256 digest.");
  const evidenceUrl = requireHttpsUrl(manifest.evidence.platformControlsEvidenceUrl, "evidence.platformControlsEvidenceUrl");
  requireValue(typeof manifest.externalControls.supabaseProjectRef === "string" && manifest.externalControls.supabaseProjectRef.trim().length > 0, "externalControls.supabaseProjectRef is required.");

  return {
    releaseVersion,
    expectedSha,
    evidenceUrl,
    expected: {
      releaseVersion,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      preparedAt: manifest.release.preparedAt,
      supabaseProjectRef: manifest.externalControls.supabaseProjectRef,
      developBranchProtectionVerified: manifest.externalControls.developBranchProtectionVerified,
      mainBranchProtectionVerified: manifest.externalControls.mainBranchProtectionVerified,
      supabaseLeakedPasswordProtectionVerified: manifest.externalControls.supabaseLeakedPasswordProtectionVerified,
    },
  };
}

export function verifyReleaseBoundPlatformControlsBytes(manifest, bytes, sourceUrl = "local-release-evidence") {
  const { expectedSha, expected } = releaseExpectations(manifest);
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "platform-controls evidence bytes are required.");
  requireValue(bytes.byteLength > 0, "platform-controls evidence is empty.");
  requireValue(bytes.byteLength <= MAX_EVIDENCE_BYTES, `platform-controls evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actualSha = sha256Hex(bytes);
  requireValue(actualSha === expectedSha, `platform-controls evidence sha256 ${actualSha} does not match release manifest ${expectedSha}.`);

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateProductionPlatformControlsEvidence(evidence, expected);
  return { ...summary, evidenceSha256: actualSha, sourceUrl };
}

async function assertNoSymlinkPath(root, filePath) {
  const relative = path.relative(root, filePath);
  requireValue(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), "platform-controls evidence path escapes the repository checkout.");
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); } catch {
      fail(`required platform-controls evidence path component is missing: ${path.relative(root, cursor)}.`);
    }
    requireValue(!metadata.isSymbolicLink(), `platform-controls evidence path must not contain symbolic links: ${path.relative(root, cursor)}.`);
  }
}

export async function verifyReleasePlatformControlsEvidence(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { releaseVersion, evidenceUrl } = releaseExpectations(manifest);
  const root = path.resolve(process.cwd());
  const evidenceRelativePath = `docs/releases/${releaseVersion}/platform-controls-evidence.json`;
  const evidencePath = path.resolve(root, evidenceRelativePath);
  requireValue(evidencePath.startsWith(`${path.join(root, "docs", "releases")}${path.sep}`), "derived platform-controls evidence path escapes docs/releases.");
  await assertNoSymlinkPath(root, evidencePath);
  const metadata = await lstat(evidencePath);
  requireValue(metadata.isFile(), `${evidenceRelativePath} must be a regular file.`);
  requireValue(metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES, `${evidenceRelativePath} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes.`);
  const bytes = await readFile(evidencePath);
  return verifyReleaseBoundPlatformControlsBytes(manifest, bytes, `${evidenceRelativePath} (archive: ${evidenceUrl})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(process.cwd(), process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json");
  verifyReleasePlatformControlsEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production platform-controls evidence verified: ${JSON.stringify(summary)}`);
    console.log("Scope: this gate verifies exact reviewed evidence bytes and release binding; it does not enable GitHub/Supabase controls or replace the trusted target-side live GitHub protected-state check.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
