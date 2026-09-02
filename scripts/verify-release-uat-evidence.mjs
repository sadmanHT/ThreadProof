#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionUatEvidence } from "./production-uat-evidence.mjs";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`Release UAT evidence verification failed: ${message}`);
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

  const releaseVersion = String(manifest.release.version ?? "").trim();
  requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
  const expectedSha = String(manifest.evidence.uatAdversarialEvidenceSha256 ?? "").toLowerCase();
  requireValue(SHA256.test(expectedSha) && !/^0{64}$/.test(expectedSha), "evidence.uatAdversarialEvidenceSha256 must be a non-zero 64-character SHA-256 digest.");
  const evidenceUrl = requireHttpsUrl(manifest.evidence.uatAdversarialEvidenceUrl, "evidence.uatAdversarialEvidenceUrl");

  const contracts = {};
  for (const entry of manifest.contracts) {
    requireValue(isRecord(entry) && typeof entry.name === "string" && typeof entry.address === "string", "release manifest contract entries must contain name and address.");
    requireValue(contracts[entry.name] === undefined, `release manifest contract ${entry.name} is duplicated.`);
    contracts[entry.name] = entry.address;
  }

  return {
    releaseVersion,
    expectedSha,
    evidenceUrl,
    expected: {
      releaseVersion,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      chainId: manifest.chain.chainId,
      genesisHash: manifest.chain.genesisHash,
      validatorCount: manifest.chain.validatorCount,
      deploymentManifestSha256: manifest.evidence.deploymentManifestSha256,
      signerMode: manifest.signing.mode,
      kmsOrHsmBacked: manifest.signing.kmsOrHsmBacked,
      preparedAt: manifest.release.preparedAt,
      contracts,
    },
  };
}

export function verifyReleaseBoundUatBytes(manifest, bytes, sourceUrl = "local-release-evidence") {
  const { expectedSha, expected } = releaseExpectations(manifest);
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "UAT evidence bytes are required.");
  requireValue(bytes.byteLength > 0, "UAT evidence is empty.");
  requireValue(bytes.byteLength <= MAX_EVIDENCE_BYTES, `UAT evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const actualSha = sha256Hex(bytes);
  requireValue(actualSha === expectedSha, `UAT evidence sha256 ${actualSha} does not match release manifest ${expectedSha}.`);

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateProductionUatEvidence(evidence, expected);
  return { ...summary, evidenceSha256: actualSha, sourceUrl };
}

async function assertNoSymlinkPath(root, filePath) {
  const relative = path.relative(root, filePath);
  requireValue(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), "UAT evidence path escapes the repository checkout.");
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); } catch {
      fail(`required UAT evidence path component is missing: ${path.relative(root, cursor)}.`);
    }
    requireValue(!metadata.isSymbolicLink(), `UAT evidence path must not contain symbolic links: ${path.relative(root, cursor)}.`);
  }
}

export async function verifyReleaseUatEvidence(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { releaseVersion, evidenceUrl } = releaseExpectations(manifest);
  const root = path.resolve(process.cwd());
  const evidenceRelativePath = `docs/releases/${releaseVersion}/uat-adversarial-evidence.json`;
  const evidencePath = path.resolve(root, evidenceRelativePath);
  requireValue(evidencePath.startsWith(`${path.join(root, "docs", "releases")}${path.sep}`), "derived UAT evidence path escapes docs/releases.");
  await assertNoSymlinkPath(root, evidencePath);
  const metadata = await lstat(evidencePath);
  requireValue(metadata.isFile(), `${evidenceRelativePath} must be a regular file.`);
  requireValue(metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES, `${evidenceRelativePath} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes.`);
  const bytes = await readFile(evidencePath);
  return verifyReleaseBoundUatBytes(manifest, bytes, `${evidenceRelativePath} (archive: ${evidenceUrl})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(process.cwd(), process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json");
  verifyReleaseUatEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production UAT/adversarial evidence verified: ${JSON.stringify(summary)}`);
    console.log("Scope: this gate verifies bytes, required scenarios, distinct consortium identities, and release/chain/deployment binding; it does not independently prove physical-world truth or participant honesty.");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
