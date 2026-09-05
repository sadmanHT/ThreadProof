#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionCeremonyEvidence } from "./production-ceremony-evidence.mjs";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const HASH32 = /^0x[0-9a-f]{64}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const CIRCUITS = Object.freeze({
  capacitySpend: Object.freeze({
    circuit: "CapacitySpend",
    filename: "capacity-spend-ceremony-evidence.json",
  }),
  capacityRelease: Object.freeze({
    circuit: "CapacityRelease",
    filename: "capacity-release-ceremony-evidence.json",
  }),
});

function fail(message) {
  throw new Error(`Release ceremony evidence verification failed: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sha256Hash32(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
function requireHash32(value, label) {
  requireValue(typeof value === "string" && HASH32.test(value), `${label} must be a 0x-prefixed 32-byte hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function requireHttpsUrl(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  requireValue(!url.username && !url.password, `${label} must not contain URL credentials.`);
  return url.toString();
}

function releaseExpectations(manifest, verifierKey) {
  requireValue(isRecord(manifest?.release), "release manifest release section is required.");
  requireValue(isRecord(manifest?.verifiers), "release manifest verifiers section is required.");
  const config = CIRCUITS[verifierKey];
  requireValue(Boolean(config), `unsupported verifier key ${verifierKey}.`);
  const verifier = manifest.verifiers[verifierKey];
  requireValue(isRecord(verifier), `release manifest verifiers.${verifierKey} is required.`);

  const releaseVersion = String(manifest.release.version ?? "").trim();
  requireValue(VERSION.test(releaseVersion), "release.version must be a semantic version such as v1.0.0.");
  requireValue(verifier.setup === "production-ceremony", `verifiers.${verifierKey}.setup must equal production-ceremony.`);
  requireValue(Number.isSafeInteger(verifier.circuitVersion) && verifier.circuitVersion > 0, `verifiers.${verifierKey}.circuitVersion must be positive.`);
  const ceremonyEvidenceSha256 = requireHash32(
    verifier.ceremonyEvidenceSha256,
    `verifiers.${verifierKey}.ceremonyEvidenceSha256`,
  );
  const buildAttestationSha256 = requireHash32(
    verifier.buildAttestationSha256,
    `verifiers.${verifierKey}.buildAttestationSha256`,
  );
  const ceremonyEvidenceUrl = requireHttpsUrl(
    verifier.ceremonyEvidenceUrl,
    `verifiers.${verifierKey}.ceremonyEvidenceUrl`,
  );

  return {
    releaseVersion,
    config,
    ceremonyEvidenceSha256,
    ceremonyEvidenceUrl,
    expected: {
      circuit: config.circuit,
      circuitVersion: verifier.circuitVersion,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      preparedAt: manifest.release.preparedAt,
      buildAttestationSha256,
    },
  };
}

export function verifyReleaseBoundCeremonyBytes(manifest, verifierKey, bytes, sourceUrl = "local-release-evidence") {
  const { ceremonyEvidenceSha256, expected } = releaseExpectations(manifest, verifierKey);
  requireValue(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, `${verifierKey} ceremony evidence bytes are required.`);
  requireValue(bytes.byteLength > 0, `${verifierKey} ceremony evidence is empty.`);
  requireValue(bytes.byteLength <= MAX_EVIDENCE_BYTES, `${verifierKey} ceremony evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);

  const actualSha = sha256Hash32(bytes);
  requireValue(
    actualSha === ceremonyEvidenceSha256,
    `${verifierKey} ceremony evidence sha256 ${actualSha} does not match release manifest ${ceremonyEvidenceSha256}.`,
  );

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`${verifierKey} evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = validateProductionCeremonyEvidence(evidence, expected);
  return { ...summary, verifierKey, ceremonyEvidenceSha256: actualSha, sourceUrl };
}

async function assertNoSymlinkPath(root, filePath, label) {
  const relative = path.relative(root, filePath);
  requireValue(
    relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label} path escapes the repository checkout.`,
  );
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let metadata;
    try { metadata = await lstat(cursor); } catch {
      fail(`required ${label} path component is missing: ${path.relative(root, cursor)}.`);
    }
    requireValue(!metadata.isSymbolicLink(), `${label} path must not contain symbolic links: ${path.relative(root, cursor)}.`);
  }
}

export async function verifyReleaseCeremonyEvidence(manifestPath, rootOverride) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = path.resolve(rootOverride ?? process.cwd());
  const summaries = {};
  for (const verifierKey of Object.keys(CIRCUITS)) {
    const { releaseVersion, config, ceremonyEvidenceUrl } = releaseExpectations(manifest, verifierKey);
    const evidenceRelativePath = `docs/releases/${releaseVersion}/${config.filename}`;
    const evidencePath = path.resolve(root, evidenceRelativePath);
    requireValue(
      evidencePath.startsWith(`${path.join(root, "docs", "releases")}${path.sep}`),
      `derived ${verifierKey} ceremony evidence path escapes docs/releases.`,
    );
    await assertNoSymlinkPath(root, evidencePath, `${verifierKey} ceremony evidence`);
    const metadata = await lstat(evidencePath);
    requireValue(metadata.isFile(), `${evidenceRelativePath} must be a regular file.`);
    requireValue(
      metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES,
      `${evidenceRelativePath} must be between 1 and ${MAX_EVIDENCE_BYTES} bytes.`,
    );
    const bytes = await readFile(evidencePath);
    summaries[verifierKey] = verifyReleaseBoundCeremonyBytes(
      manifest,
      verifierKey,
      bytes,
      `${evidenceRelativePath} (archive: ${ceremonyEvidenceUrl})`,
    );
  }
  return summaries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(
    process.cwd(),
    process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json",
  );
  verifyReleaseCeremonyEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production ceremony evidence verified: ${JSON.stringify(summary)}`);
    console.log(
      "Scope: this gate hashes committed ceremony JSON bytes before parsing and binds them to the manifest/source/build attestations. It does not run the real ceremony, create contributions, or prove participant independence.",
    );
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
