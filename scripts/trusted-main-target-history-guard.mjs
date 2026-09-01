#!/usr/bin/env node

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const ALLOWED_MAIN_ONLY_DELTA = [
  /^\.github\/workflows\/release-candidate-guard\.yml$/,
  /^scripts\/trusted-main-release-guard\.mjs$/,
  /^scripts\/trusted-main-target-history-guard\.mjs$/,
  /^docs\/MAIN_RELEASE_GUARD_BOOTSTRAP\.md$/,
  /^release\/production-release\.json$/,
  /^CHANGELOG\.md$/,
  /^docs\/releases\/.+/,
];

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const headSha = process.env.THREADPROOF_RELEASE_HEAD_SHA?.trim();
const baseSha = process.env.THREADPROOF_RELEASE_BASE_SHA?.trim();
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `trusted target-history guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof headSha === "string" && GIT_SHA.test(headSha), "release PR head SHA must be a full 40-character Git SHA.");
requireValue(typeof baseSha === "string" && GIT_SHA.test(baseSha), "release PR base SHA must be a full 40-character Git SHA.");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ThreadProof-trusted-main-target-history-guard",
};

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API ${path} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchCandidateSourceCommit() {
  const payload = await github(
    `/repos/${CANONICAL_REPOSITORY}/contents/release/production-release.json?ref=${encodeURIComponent(headSha)}`,
  );
  requireValue(
    payload?.type === "file" && payload?.encoding === "base64" && typeof payload?.content === "string",
    "release candidate manifest could not be read at the exact PR head SHA.",
  );
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (error) {
    fail(`release candidate manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sourceCommit = manifest?.release?.sourceDevelopCommit;
  requireValue(
    typeof sourceCommit === "string" && GIT_SHA.test(sourceCommit) && !/^0{40}$/i.test(sourceCommit),
    "release.sourceDevelopCommit must be a non-zero full 40-character Git SHA.",
  );
  return sourceCommit.toLowerCase();
}

async function compare(base, head) {
  return github(
    `/repos/${CANONICAL_REPOSITORY}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
}

try {
  const sourceCommit = await fetchCandidateSourceCommit();

  // `main` and the selected tested develop source may be intentionally diverged.
  // First resolve their common ancestor, then inspect only the target-side history.
  const targetVsSource = await compare(baseSha, sourceCommit);
  const mergeBase = targetVsSource?.merge_base_commit?.sha?.toLowerCase();
  requireValue(
    typeof mergeBase === "string" && GIT_SHA.test(mergeBase),
    "GitHub did not return a valid merge base between main and release.sourceDevelopCommit.",
  );

  const targetOnly = await compare(mergeBase, baseSha);
  requireValue(
    ["ahead", "identical"].includes(targetOnly?.status),
    `current main must descend from the resolved merge base; compare status was ${targetOnly?.status ?? "missing"}.`,
  );
  requireValue(Array.isArray(targetOnly.files), "GitHub compare did not return the main-only file list.");
  requireValue(
    targetOnly.files.length < 300,
    "main-only delta reached GitHub's 300-file compare limit and cannot be proven complete.",
  );

  for (const file of targetOnly.files) {
    requireValue(typeof file?.filename === "string", "main-only delta contains a file without a filename.");
    requireValue(
      ALLOWED_MAIN_ONLY_DELTA.some((pattern) => pattern.test(file.filename)),
      `untested main-only code/config would enter the production merge: ${file.filename}`,
    );
  }

  const mainBranch = await github(`/repos/${CANONICAL_REPOSITORY}/branches/main`);
  requireValue(
    mainBranch?.commit?.sha?.toLowerCase() === baseSha.toLowerCase(),
    "main moved during target-history verification; a fresh trusted guard run is required.",
  );

  console.log("Trusted main target-history guard passed.");
  console.log(`Tested develop source: ${sourceCommit}`);
  console.log(`Main base: ${baseSha}`);
  console.log(`Merge base: ${mergeBase}`);
  console.log(`Allowed main-only changed files: ${targetOnly.files.length}`);
} catch (error) {
  console.error(
    `THREADPROOF_TRUSTED_MAIN_TARGET_HISTORY_GUARD_FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
