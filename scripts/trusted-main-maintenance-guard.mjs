#!/usr/bin/env node

import { createHash } from "node:crypto";

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const MAINTENANCE_PREFIX = "security/trusted-main-guard/";
const REVIEW_LABEL = "trusted-main-reviewed";
const ALLOWED_MAINTENANCE_FILES = new Set([
  ".github/workflows/release-candidate-guard.yml",
  "scripts/trusted-main-release-guard.mjs",
  "scripts/trusted-main-target-history-guard.mjs",
  "scripts/trusted-main-build-evidence-guard.mjs",
  "scripts/trusted-main-maintenance-guard.mjs",
  "docs/MAIN_RELEASE_GUARD_BOOTSTRAP.md",
]);
const POLICY_FILES = new Set([
  ".github/workflows/release-candidate-guard.yml",
  "scripts/trusted-main-release-guard.mjs",
  "scripts/trusted-main-target-history-guard.mjs",
  "scripts/trusted-main-build-evidence-guard.mjs",
  "scripts/trusted-main-maintenance-guard.mjs",
]);
const ALLOWED_WORKFLOW_SHA256 = new Set([
  "0cb214dbff3f430933e391e6e79c503490dbe0bd2a8c0afdebe751e915f71fa4",
]);
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const FORBIDDEN_TEXT = /(todo|tbd|placeholder|replace[-_ ]?me|example|dummy|changeme)/i;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function cleanReference(value) {
  requireValue(typeof value === "string", "Trusted-Main-Change-Reference is required in the PR body.");
  const text = value.trim();
  requireValue(text.length >= 8, "Trusted-Main-Change-Reference must be a meaningful auditable reference.");
  requireValue(!FORBIDDEN_TEXT.test(text), "Trusted-Main-Change-Reference contains placeholder text.");
  return text;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const headSha = process.env.THREADPROOF_MAINTENANCE_HEAD_SHA?.trim();
const baseSha = process.env.THREADPROOF_MAINTENANCE_BASE_SHA?.trim();
const headRepo = process.env.THREADPROOF_MAINTENANCE_HEAD_REPOSITORY?.trim();
const headRef = process.env.THREADPROOF_MAINTENANCE_HEAD_REF?.trim();
const prNumber = Number(process.env.THREADPROOF_MAINTENANCE_PR_NUMBER);
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `trusted maintenance guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof headSha === "string" && GIT_SHA.test(headSha), "maintenance PR head SHA must be a full 40-character Git SHA.");
requireValue(typeof baseSha === "string" && GIT_SHA.test(baseSha), "maintenance PR base SHA must be a full 40-character Git SHA.");
requireValue(headRepo === CANONICAL_REPOSITORY, "trusted-main maintenance PR must originate from the canonical repository, not a fork.");
requireValue(typeof headRef === "string" && headRef.startsWith(MAINTENANCE_PREFIX) && headRef.length > MAINTENANCE_PREFIX.length, `trusted-main maintenance branch must use the ${MAINTENANCE_PREFIX} prefix.`);
requireValue(Number.isSafeInteger(prNumber) && prNumber > 0, "maintenance PR number is invalid.");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "ThreadProof-trusted-main-maintenance-guard",
};

async function github(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API ${path} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function fetchUtf8File(path) {
  const payload = await github(`/repos/${CANONICAL_REPOSITORY}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(headSha)}`);
  requireValue(payload?.type === "file" && payload?.encoding === "base64" && typeof payload?.content === "string", `${path} could not be read as a candidate file at the exact PR head SHA.`);
  return Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function verifyCandidateWorkflow(text) {
  const workflowSha256 = sha256Text(text);
  requireValue(
    ALLOWED_WORKFLOW_SHA256.has(workflowSha256),
    `candidate trusted-main workflow executable surface is not pre-approved; SHA-256 ${workflowSha256} is not in the trusted allowlist. Update the maintenance guard in a separate reviewed PR before changing the workflow.`,
  );

  // Defense in depth around the pre-approved byte hash. These checks make the
  // intended trust boundary obvious during future review even if the allowlist
  // is expanded deliberately.
  const required = [
    "pull_request_target:",
    "branches: [main]",
    "permissions:",
    "actions: read",
    "contents: read",
    "pull-requests: read",
    "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "ref: ${{ github.event.pull_request.base.sha }}",
    "fetch-depth: 1",
    "persist-credentials: false",
    "runs-on: ubuntu-latest",
    "scripts/trusted-main-maintenance-guard.mjs",
  ];
  for (const marker of required) {
    requireValue(text.includes(marker), `candidate trusted-main workflow is missing required safety marker: ${marker}`);
  }
  for (const forbidden of [
    "actions: write",
    "contents: write",
    "pull-requests: write",
    "id-token: write",
    "packages: write",
    "security-events: write",
    "secrets.",
    "persist-credentials: true",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "ref: ${{ github.event.pull_request.head.ref }}",
    "working-directory:",
    "container:",
    "services:",
  ]) {
    requireValue(!text.includes(forbidden), `candidate trusted-main workflow contains forbidden privilege/checkout marker: ${forbidden}`);
  }

  const uses = [...text.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  requireValue(uses.length === 2, `candidate trusted-main workflow must contain exactly two pinned action uses; found ${uses.length}.`);
  requireValue(uses[0] === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "first trusted action must remain the pinned checkout action.");
  requireValue(uses[1] === "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "second trusted action must remain the pinned setup-node action.");
  requireValue((text.match(/^permissions:\s*$/gm) ?? []).length === 1, "candidate trusted-main workflow must contain exactly one top-level permissions block.");
  requireValue((text.match(/^  trusted-main-release-guard:\s*$/gm) ?? []).length === 1, "candidate trusted-main workflow must retain exactly one trusted-main-release-guard job.");
}

const pr = await github(`/repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}`);
requireValue(pr?.state === "open", "maintenance PR must still be open while the trusted check executes.");
requireValue(pr?.draft === false, "maintenance PR must be marked ready for review.");
requireValue(pr?.base?.ref === "main", "trusted-main maintenance PR must target main.");
requireValue(pr?.base?.sha?.toLowerCase() === baseSha.toLowerCase(), "maintenance PR base SHA moved while verification was running.");
requireValue(pr?.head?.sha?.toLowerCase() === headSha.toLowerCase(), "maintenance PR head SHA moved while verification was running.");
requireValue(pr?.head?.repo?.full_name === CANONICAL_REPOSITORY, "maintenance PR head repository changed or is not canonical.");
requireValue(pr?.head?.ref === headRef, "maintenance PR head branch changed while verification was running.");

const labels = new Set((pr?.labels ?? []).map((label) => label?.name).filter(Boolean));
requireValue(labels.has(REVIEW_LABEL), `maintenance PR requires the manually applied ${REVIEW_LABEL} label before it can pass.`);

const referenceMatch = typeof pr?.body === "string" ? pr.body.match(/^Trusted-Main-Change-Reference:\s*(.+)$/im) : null;
const changeReference = cleanReference(referenceMatch?.[1]);

const comparison = await github(`/repos/${CANONICAL_REPOSITORY}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`);
requireValue(comparison?.status === "ahead", `maintenance head must be strictly ahead of the reviewed main base; compare status was ${comparison?.status ?? "missing"}.`);
requireValue(Array.isArray(comparison?.files) && comparison.files.length > 0, "maintenance comparison returned no changed files.");

let policyFileChanged = false;
for (const file of comparison.files) {
  const filename = file?.filename;
  requireValue(typeof filename === "string" && ALLOWED_MAINTENANCE_FILES.has(filename), `maintenance PR changes forbidden path: ${filename ?? "missing filename"}.`);
  requireValue(file?.status !== "removed", `trusted-main maintenance file may not be deleted: ${filename}.`);
  if (POLICY_FILES.has(filename)) policyFileChanged = true;
}
requireValue(policyFileChanged, "maintenance PR must change at least one trusted-main policy/workflow file; documentation-only maintenance is not accepted by this path.");

const candidateWorkflow = await fetchUtf8File(".github/workflows/release-candidate-guard.yml");
verifyCandidateWorkflow(candidateWorkflow);

const main = await github(`/repos/${CANONICAL_REPOSITORY}/branches/main`);
requireValue(main?.commit?.sha?.toLowerCase() === baseSha.toLowerCase(), "main advanced while trusted-main maintenance verification was running; rebase/reopen against the new target.");

console.log(`Trusted-main maintenance candidate ${headSha} accepted for change reference ${changeReference}.`);
console.log(`Changed files: ${comparison.files.map((file) => file.filename).join(", ")}`);
console.log(`Candidate workflow SHA-256: ${sha256Text(candidateWorkflow)}.`);
console.log(`Manual review signal: ${REVIEW_LABEL}. Candidate code was read through the GitHub API and was not executed.`);
