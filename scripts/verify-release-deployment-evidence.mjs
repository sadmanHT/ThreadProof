#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionDeploymentEvidence } from "./production-deployment-evidence.mjs";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`Release deployment evidence verification failed: ${message}`);
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
  requireValue(isRecord(manifest?.chain), "release manifest chain section is required.");
  requireValue(isRecord(manifest?.signing), "release manifest signing section is required.");
  requireValue(isRecord(manifest?.evidence), "release manifest evidence section is required.");
  requireValue(Array.isArray(manifest?.contracts), "release manifest contracts must be an array.");
  requireValue(isRecord(manifest?.verifiers), "release manifest verifiers section is required.");

  const releaseVersion = String(manifest.release.version ?? "").trim();
  requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
  const expectedSha = String(manifest.evidence.deploymentManifestSha256 ?? "").toLowerCase();
  requireValue(SHA256.test(expectedSha) && !/^0{64}$/.test(expectedSha), "evidence.deploymentManifestSha256 must be a non-zero 64-character SHA-256 digest.");
  const evidenceUrl = requireHttpsUrl(manifest.evidence.deploymentEvidenceUrl, "evidence.deploymentEvidenceUrl");

  return {
    releaseVersion,
    expectedSha,
    evidenceUrl,
    expected: {
      releaseVersion,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      preparedAt: manifest.release.preparedAt,
      networkName: manifest.chain.networkName,
      chainId: manifest.chain.chainId,
      genesisHash: manifest.chain.genesisHash,
      validatorCount: manifest.chain.validatorCount,
      signerMode: manifest.signing.mode,
      kmsOrHsmBacked: manifest.signing.kmsOrHsmBacked,
      contracts: manifest.contracts,
      verifiers: manifest.verifiers,
    },
  };
}

export function verifyReleaseBoundDeploymentBytes(manifest, bytes, sourceUrl = "local-release-evidence") {
  const { expectedSha, expected } = releaseExpectations(manifest);
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "deployment evidence bytes are required.");
  requireValue(bytes.byteLength > 0, "deployment evidence is empty.");
  requireValue(bytes.byteLength <= MAX_EVIDENCE_BYTES, `deployment evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actualSha = sha256Hex(bytes);
  requireValue(actualSha === expectedSha, `deployment evidence sha256 ${actualSha} does not match release manifest ${expectedSha}.`);

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateProductionDeploymentEvidence(evidence, expected);
  return { ...summary, evidenceSha256: actualSha, sourceUrl };
}

async function assertNoSymlinkPath(root, filePath) {
  const relative = path.relative(root, filePath);
  requireValue(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), "deployment evidence path escapes the repository checkout.");
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); } catch {
      fail(`required deployment evidence path component is missing: ${path.relative(root, cursor)}.`);
    }
    requireValue(!metadata.isSymbolicLink(), `deployment evidence path must not contain symbolic links: ${path.relative(root, cursor)}.`);
  }
}

export async function verifyReleaseDeploymentEvidence(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { releaseVersion, evidenceUrl } = releaseExpectations(manifest);
  const root = path.resolve(process.cwd());
  const evidenceRelativePath = `docs/releases/${releaseVersion}/deployment-evidence.json`;
  const evidencePath = path.resolve(root, evidenceRelativePath);
  requireValue(evidencePath.startsWith(`${path.join(root, "docs", "releases")}${path.sep}`), "derived deployment evidence path escapes docs/releases.");
  await assertNoSymlinkPath(root, evidencePath);
  const metadata = await lstat(evidencePath);
  requireValue(metadata.isFile(), `${evidenceRelativePath} must be a regular file.`);
  requireValue(metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES, `${evidenceRelativePath} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes.`);
  const bytes = await readFile(evidencePath);
  return verifyReleaseBoundDeploymentBytes(manifest, bytes, `${evidenceRelativePath} (archive: ${evidenceUrl})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(process.cwd(), process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json");
  verifyReleaseDeploymentEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production deployment evidence verified: ${JSON.stringify(summary)}`);
    console.log("Scope: this gate verifies exact bytes and declared production topology/runtime bindings; it does not provision infrastructure or prove real-world administrative independence.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
