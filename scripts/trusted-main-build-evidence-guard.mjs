#!/usr/bin/env node

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const headSha = process.env.THREADPROOF_RELEASE_HEAD_SHA?.trim();
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `trusted build-evidence guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof headSha === "string" && GIT_SHA.test(headSha), "release PR head SHA must be a full 40-character Git SHA.");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ThreadProof-trusted-main-build-evidence-guard",
};

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API ${path} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function requireBuildDigest(value, label) {
  requireValue(
    typeof value === "string" && HASH32.test(value) && !/^0x0{64}$/i.test(value),
    `${label} must be a non-zero 32-byte 0x-prefixed SHA-256 digest.`,
  );
}

try {
  const payload = await github(
    `/repos/${CANONICAL_REPOSITORY}/contents/release/production-release.json?ref=${encodeURIComponent(headSha)}`,
  );
  requireValue(
    payload?.type === "file" && payload?.encoding === "base64" && typeof payload?.content === "string",
    "release candidate manifest could not be read at the exact PR head SHA.",
  );
  const manifest = JSON.parse(Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8"));
  requireBuildDigest(
    manifest?.verifiers?.capacitySpend?.buildAttestationSha256,
    "verifiers.capacitySpend.buildAttestationSha256",
  );
  requireBuildDigest(
    manifest?.verifiers?.capacityRelease?.buildAttestationSha256,
    "verifiers.capacityRelease.buildAttestationSha256",
  );
  console.log("Trusted main build-evidence guard passed for both production verifier entries.");
} catch (error) {
  console.error(
    `THREADPROOF_TRUSTED_MAIN_BUILD_EVIDENCE_GUARD_FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
