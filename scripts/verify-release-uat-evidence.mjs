#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateProductionUatEvidence } from "./production-uat-evidence.mjs";

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
const SHA256 = /^[0-9a-f]{64}$/i;

function fail(message) {
  throw new Error(`Release UAT evidence verification failed: ${message}`);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  return true;
}

function isPublicAddress(address) {
  const normalized = address.replace(/^\[/, "").replace(/\]$/, "");
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

export async function assertSafeEvidenceUrl(value, label = "UAT evidence URL") {
  let url;
  try { url = value instanceof URL ? new URL(value) : new URL(value); } catch { fail(`${label} must be a valid URL.`); }
  if (url.protocol !== "https:") fail(`${label} must use https.`);
  if (url.username || url.password) fail(`${label} must not contain URL credentials.`);

  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!hostname) fail(`${label} must include a hostname.`);
  let addresses;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      fail(`${label} hostname ${hostname} could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!addresses || addresses.length === 0) fail(`${label} hostname ${hostname} resolved to no addresses.`);
  for (const resolved of addresses) {
    if (!isPublicAddress(resolved.address)) {
      fail(`${label} resolves to non-public address ${resolved.address}; private, loopback, link-local, documentation, and reserved targets are forbidden.`);
    }
  }
  return url;
}

export function verifyReleaseBoundUatBytes(manifest, bytes, sourceUrl = "https://local.invalid/uat.json") {
  if (!isRecord(manifest?.release) || !isRecord(manifest?.chain) || !isRecord(manifest?.evidence)) {
    fail("release manifest is missing release, chain, or evidence sections.");
  }
  const expectedSha = String(manifest.evidence.uatAdversarialEvidenceSha256 ?? "").toLowerCase();
  if (!SHA256.test(expectedSha) || /^0{64}$/.test(expectedSha)) {
    fail("evidence.uatAdversarialEvidenceSha256 must be a non-zero 64-character SHA-256 digest.");
  }
  const actualSha = sha256Hex(bytes);
  if (actualSha !== expectedSha) fail(`downloaded bytes sha256 ${actualSha} do not match release manifest ${expectedSha}.`);

  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    fail(`evidence from ${sourceUrl} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const summary = validateProductionUatEvidence(evidence, {
    sourceDevelopCommit: manifest.release.sourceDevelopCommit,
    chainId: manifest.chain.chainId,
    genesisHash: manifest.chain.genesisHash,
    deploymentManifestSha256: manifest.evidence.deploymentManifestSha256,
  });
  return { ...summary, evidenceSha256: actualSha, sourceUrl };
}

async function readBoundedResponse(response) {
  if (!response.body) fail("UAT evidence response has no body.");
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EVIDENCE_BYTES) {
        await reader.cancel();
        fail(`evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchEvidence(initialUrl) {
  let current = await assertSafeEvidenceUrl(initialUrl, "evidence.uatAdversarialEvidenceUrl");
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) fail(`UAT evidence exceeded ${MAX_REDIRECTS} redirects.`);
      const location = response.headers.get("location");
      if (!location) fail(`UAT evidence redirect ${response.status} is missing Location.`);
      current = await assertSafeEvidenceUrl(new URL(location, current), "UAT evidence redirect URL");
      continue;
    }
    return { response, finalUrl: current.toString() };
  }
  fail("UAT evidence redirect resolution failed.");
}

export async function verifyReleaseUatEvidence(manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    fail(`could not read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = manifest?.evidence?.uatAdversarialEvidenceUrl;
  if (typeof url !== "string") fail("evidence.uatAdversarialEvidenceUrl is required.");

  const { response, finalUrl } = await fetchEvidence(url);
  if (!response.ok) fail(`GET ${finalUrl} returned HTTP ${response.status}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0) fail("UAT evidence Content-Length is invalid.");
    if (declaredLength > MAX_EVIDENCE_BYTES) fail(`evidence exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  }
  const bytes = await readBoundedResponse(response);
  return verifyReleaseBoundUatBytes(manifest, bytes, finalUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = path.resolve(process.cwd(), process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json");
  verifyReleaseUatEvidence(manifestPath).then((summary) => {
    console.log(`Release-bound production UAT/adversarial evidence verified: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
