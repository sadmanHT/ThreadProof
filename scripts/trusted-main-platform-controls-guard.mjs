#!/usr/bin/env node

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const GIT_SHA = /^[0-9a-fA-F]{40}$/;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const baseSha = process.env.THREADPROOF_RELEASE_BASE_SHA?.trim();
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `platform-controls guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof baseSha === "string" && GIT_SHA.test(baseSha), "release base SHA must be a full 40-character Git SHA.");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ThreadProof-trusted-main-platform-controls-guard",
};

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API ${path} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function requireProtectedBranch(branchName) {
  const branch = await github(`/repos/${CANONICAL_REPOSITORY}/branches/${encodeURIComponent(branchName)}`);
  requireValue(branch?.name === branchName, `${branchName} branch metadata is missing or malformed.`);
  requireValue(typeof branch?.commit?.sha === "string" && GIT_SHA.test(branch.commit.sha), `${branchName} branch commit SHA is invalid.`);
  requireValue(branch?.protected === true, `${branchName} is not protected by GitHub branch protection or an applicable ruleset.`);

  const requiredStatusChecks = branch?.protection?.required_status_checks;
  const contexts = Array.isArray(requiredStatusChecks?.contexts) ? requiredStatusChecks.contexts : [];
  const checks = Array.isArray(requiredStatusChecks?.checks) ? requiredStatusChecks.checks : [];

  return {
    name: branchName,
    sha: branch.commit.sha.toLowerCase(),
    protected: true,
    classicProtectionEnabled: branch?.protection?.enabled === true,
    visibleRequiredStatusCheckCount: Math.max(contexts.length, checks.length),
  };
}

try {
  const [main, develop] = await Promise.all([
    requireProtectedBranch("main"),
    requireProtectedBranch("develop"),
  ]);

  requireValue(main.sha === baseSha.toLowerCase(), "main moved during live platform-controls verification; rerun against the current target is required.");

  console.log(`Live GitHub protected-state verified: ${JSON.stringify({ main, develop })}`);
  console.log("Scope: protected=true confirms GitHub reports an active branch-protection/ruleset boundary. This check does not prove the complete required-check, reviewer, merge-queue, force-push or deletion policy semantics; issue #23 still requires independent platform verification.");
} catch (error) {
  console.error(`THREADPROOF_TRUSTED_MAIN_PLATFORM_CONTROLS_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
