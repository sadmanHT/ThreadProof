#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
const PLATFORM_CONTROLS_FORMAT = "threadproof-production-platform-controls/v1";
const REQUIRED_MAIN_STATUS_CHECK = "ThreadProof Trusted Main Release Guard / trusted-main-release-guard";
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PROJECT_REF = /^[a-z0-9]{12,40}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const FORBIDDEN_TEXT = /(^|[^a-z])(todo|tbd|placeholder|replace[_ -]?me|dummy|changeme|example)([^a-z]|$)/i;
const FORBIDDEN_VALUE = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|seed phrase|mnemonic phrase|bearer\s+[A-Za-z0-9._-]{12,})/i;
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
const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ADVISOR_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanText(value, label, minLength = 1) {
  requireValue(typeof value === "string" && value.trim().length >= minLength, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  requireValue(!FORBIDDEN_VALUE.test(text), `${label} appears to contain secret material.`);
  return text;
}

function requireSha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}

function requireGitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}

function requireIsoDate(value, label) {
  const text = cleanText(value, label);
  const millis = Date.parse(text);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text, millis };
}

function requireHttpsUrl(value, label) {
  const text = cleanText(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid URL.`);
  }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  requireValue(!url.username && !url.password, `${label} must not contain URL credentials.`);
  return text;
}

function requireOpaqueId(value, label) {
  const text = cleanText(value, label, 3);
  requireValue(OPAQUE_ID.test(text), `${label} must be a non-secret opaque identifier.`);
  return text;
}

function scanUnsafe(value, objectPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafe(item, `${objectPath}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_NORMALIZED_KEYS.has(normalizedKey(key)), `${objectPath}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${objectPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    requireValue(!FORBIDDEN_TEXT.test(value), `${objectPath} contains placeholder text.`);
    requireValue(!FORBIDDEN_VALUE.test(value), `${objectPath} appears to contain secret material.`);
  }
}

function validateEvidenceRef(value, label) {
  requireValue(isRecord(value), `${label} is required.`);
  requireHttpsUrl(value.url, `${label}.url`);
  requireSha256(value.sha256, `${label}.sha256`);
}

function validateBranchEvidence(value, label, { trustedMain = false } = {}) {
  requireValue(isRecord(value), `${label} is required.`);
  requireValue(value.protected === true, `${label}.protected must be true.`);
  requireValue(value.forcePushAllowed === false, `${label}.forcePushAllowed must be false.`);
  requireValue(value.deletionAllowed === false, `${label}.deletionAllowed must be false.`);
  requireValue(value.requiredStatusChecksEnforced === true, `${label}.requiredStatusChecksEnforced must be true.`);
  requireValue(value.reviewerApprovalEnforced === true, `${label}.reviewerApprovalEnforced must be true.`);
  if (trustedMain) {
    requireValue(value.requiredStatusCheck === REQUIRED_MAIN_STATUS_CHECK, `${label}.requiredStatusCheck must equal ${REQUIRED_MAIN_STATUS_CHECK}.`);
    requireValue(value.upToDateOrMergeQueueEnforced === true, `${label}.upToDateOrMergeQueueEnforced must be true.`);
  }
  validateEvidenceRef(value.evidence, `${label}.evidence`);
}

function validatePlatformEvidence(evidence, expected) {
  requireValue(isRecord(evidence), "platform-controls evidence must be a JSON object.");
  scanUnsafe(evidence);
  requireValue(evidence.format === PLATFORM_CONTROLS_FORMAT, `platform-controls format must equal ${PLATFORM_CONTROLS_FORMAT}.`);
  requireValue(evidence.result === "pass", "platform-controls result must equal pass.");
  requireValue(evidence.environment === "production", "platform-controls environment must equal production.");

  const releaseVersion = cleanText(evidence.releaseVersion, "platform-controls releaseVersion");
  requireValue(releaseVersion === expected.releaseVersion, "platform-controls releaseVersion does not match the release manifest.");
  const sourceDevelopCommit = requireGitSha(evidence.sourceDevelopCommit, "platform-controls sourceDevelopCommit");
  requireValue(sourceDevelopCommit === expected.sourceDevelopCommit, "platform-controls sourceDevelopCommit does not match release.sourceDevelopCommit.");

  const observedAt = requireIsoDate(evidence.observedAt, "platform-controls observedAt");
  requireValue(observedAt.millis <= expected.preparedAt.millis, "platform-controls observedAt must not be after release.preparedAt.");
  requireValue(expected.preparedAt.millis - observedAt.millis <= MAX_OBSERVATION_AGE_MS, "platform-controls observation is older than 24 hours at release.preparedAt.");

  requireValue(isRecord(evidence.github), "platform-controls github section is required.");
  requireValue(evidence.github.repository === CANONICAL_REPOSITORY, `platform-controls github.repository must equal ${CANONICAL_REPOSITORY}.`);
  validateBranchEvidence(evidence.github.main, "platform-controls github.main", { trustedMain: true });
  validateBranchEvidence(evidence.github.develop, "platform-controls github.develop");
  requireValue(evidence.github.rulesetReviewCompleted === true, "platform-controls github.rulesetReviewCompleted must be true.");
  validateEvidenceRef(evidence.github.reviewEvidence, "platform-controls github.reviewEvidence");

  requireValue(isRecord(evidence.supabase), "platform-controls supabase section is required.");
  requireValue(evidence.supabase.organization === "ThreadProof", "platform-controls supabase.organization must equal ThreadProof.");
  const projectRef = cleanText(evidence.supabase.projectRef, "platform-controls supabase.projectRef");
  requireValue(PROJECT_REF.test(projectRef), "platform-controls supabase.projectRef must be a lowercase project reference.");
  requireValue(projectRef === expected.supabaseProjectRef, "platform-controls supabase.projectRef does not match the release manifest.");
  requireValue(evidence.supabase.leakedPasswordProtectionEnabled === true, "platform-controls Supabase leaked-password protection must be enabled.");
  requireValue(evidence.supabase.leakedPasswordWarningAbsent === true, "platform-controls Supabase leaked-password warning must be absent.");
  const advisorObservedAt = requireIsoDate(evidence.supabase.securityAdvisorObservedAt, "platform-controls supabase.securityAdvisorObservedAt");
  requireValue(advisorObservedAt.millis <= observedAt.millis, "Supabase advisor observation must not be after platform-controls observedAt.");
  requireValue(observedAt.millis - advisorObservedAt.millis <= MAX_ADVISOR_AGE_MS, "Supabase advisor observation is older than 24 hours at platform-controls observedAt.");
  validateEvidenceRef(evidence.supabase.evidence, "platform-controls supabase.evidence");

  requireValue(isRecord(evidence.review), "platform-controls review section is required.");
  const executedBy = requireOpaqueId(evidence.review.executedBy, "platform-controls review.executedBy");
  requireValue(Array.isArray(evidence.review.reviewerIds) && evidence.review.reviewerIds.length >= 2, "platform-controls review.reviewerIds must contain at least two reviewers.");
  const reviewers = new Set();
  for (const reviewer of evidence.review.reviewerIds) {
    const reviewerId = requireOpaqueId(reviewer, "platform-controls review.reviewerIds[]");
    requireValue(!reviewers.has(reviewerId), `platform-controls reviewer ${reviewerId} is duplicated.`);
    reviewers.add(reviewerId);
  }
  requireValue(!reviewers.has(executedBy) || reviewers.size >= 3, "platform-controls evidence cannot rely only on the executor reviewing their own evidence.");
  const approvedAt = requireIsoDate(evidence.review.approvedAt, "platform-controls review.approvedAt");
  requireValue(approvedAt.millis >= observedAt.millis, "platform-controls review.approvedAt must not predate observedAt.");
  requireValue(approvedAt.millis <= expected.preparedAt.millis, "platform-controls review.approvedAt must not be after release.preparedAt.");
  cleanText(evidence.review.statement, "platform-controls review.statement", 24);

  return { releaseVersion, sourceDevelopCommit, projectRef, observedAt: observedAt.text, reviewerCount: reviewers.size };
}

const repository = process.env.GITHUB_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const baseSha = process.env.THREADPROOF_RELEASE_BASE_SHA?.trim();
const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");

requireValue(repository === CANONICAL_REPOSITORY, `platform-controls guard must run in ${CANONICAL_REPOSITORY}.`);
requireValue(Boolean(token), "GITHUB_TOKEN is required.");
requireValue(typeof baseSha === "string" && GIT_SHA.test(baseSha), "release base SHA must be a full 40-character Git SHA.");
requireValue(Boolean(eventPath), "GITHUB_EVENT_PATH is required.");

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

async function loadPullRequestEvent() {
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch (error) {
    fail(`could not read pull_request_target event payload: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pr = event?.pull_request;
  requireValue(isRecord(pr), "pull_request_target event does not contain pull_request metadata.");
  requireValue(pr?.base?.ref === "main", "platform-controls guard only accepts pull requests targeting main.");
  requireValue(pr?.base?.sha?.toLowerCase() === baseSha.toLowerCase(), "event base SHA does not match the trusted release base SHA.");
  requireValue(pr?.head?.repo?.full_name === CANONICAL_REPOSITORY, "production release candidate must originate from the canonical repository.");
  requireValue(typeof pr?.head?.ref === "string" && pr.head.ref.startsWith("release/"), "platform-controls evidence is only evaluated for release/* candidates.");
  const headSha = requireGitSha(pr?.head?.sha, "release candidate head SHA");
  return { headSha, headRef: pr.head.ref };
}

async function fetchCandidateBytes(path, headSha) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const payload = await github(`/repos/${CANONICAL_REPOSITORY}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`);
  requireValue(payload?.type === "file" && payload?.encoding === "base64" && typeof payload?.content === "string", `${path} could not be read as a regular candidate file at the exact PR head SHA.`);
  requireValue(Number.isInteger(payload?.size) && payload.size >= 0 && payload.size <= MAX_EVIDENCE_BYTES, `${path} exceeds the trusted maximum size.`);
  return Buffer.from(payload.content.replace(/\s/g, ""), "base64");
}

async function fetchCandidateJson(path, headSha) {
  const bytes = await fetchCandidateBytes(path, headSha);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { bytes, parsed };
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
  const { headSha, headRef } = await loadPullRequestEvent();
  const { parsed: manifest } = await fetchCandidateJson("release/production-release.json", headSha);
  requireValue(isRecord(manifest), "release manifest must be a JSON object.");
  requireValue(manifest.schemaVersion === 1, "release manifest schemaVersion must equal 1.");
  requireValue(isRecord(manifest.release), "release manifest release section is required.");
  const releaseVersion = cleanText(manifest.release.version, "release.version");
  requireValue(VERSION.test(releaseVersion), "release.version must be semantic version text such as v1.0.0.");
  const sourceDevelopCommit = requireGitSha(manifest.release.sourceDevelopCommit, "release.sourceDevelopCommit");
  const preparedAt = requireIsoDate(manifest.release.preparedAt, "release.preparedAt");

  requireValue(isRecord(manifest.evidence), "release manifest evidence section is required.");
  requireHttpsUrl(manifest.evidence.platformControlsEvidenceUrl, "evidence.platformControlsEvidenceUrl");
  const expectedEvidenceSha256 = requireSha256(manifest.evidence.platformControlsEvidenceSha256, "evidence.platformControlsEvidenceSha256");

  requireValue(isRecord(manifest.externalControls), "release manifest externalControls section is required.");
  requireValue(manifest.externalControls.developBranchProtectionVerified === true, "release manifest must attest develop branch protection true.");
  requireValue(manifest.externalControls.mainBranchProtectionVerified === true, "release manifest must attest main branch protection true.");
  requireValue(manifest.externalControls.supabaseLeakedPasswordProtectionVerified === true, "release manifest must attest Supabase leaked-password protection true.");
  const supabaseProjectRef = cleanText(manifest.externalControls.supabaseProjectRef, "externalControls.supabaseProjectRef");
  requireValue(PROJECT_REF.test(supabaseProjectRef), "externalControls.supabaseProjectRef must be a lowercase Supabase project reference.");

  const evidencePath = `docs/releases/${releaseVersion}/platform-controls-evidence.json`;
  const { bytes: evidenceBytes, parsed: platformEvidence } = await fetchCandidateJson(evidencePath, headSha);
  const actualEvidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  requireValue(actualEvidenceSha256 === expectedEvidenceSha256, `${evidencePath} exact-byte SHA-256 does not match the release manifest.`);

  const evidenceSummary = validatePlatformEvidence(platformEvidence, {
    releaseVersion,
    sourceDevelopCommit,
    preparedAt,
    supabaseProjectRef,
  });

  const [main, develop] = await Promise.all([
    requireProtectedBranch("main"),
    requireProtectedBranch("develop"),
  ]);
  requireValue(main.sha === baseSha.toLowerCase(), "main moved during live platform-controls verification; rerun against the current target is required.");

  console.log(`Live GitHub protected-state verified: ${JSON.stringify({ main, develop })}`);
  console.log(`Release candidate ${headRef}@${headSha} platform-controls bytes verified: ${actualEvidenceSha256}.`);
  console.log(`Sanitized platform-controls evidence verified: ${JSON.stringify(evidenceSummary)}`);
  console.log("Scope: target-side trusted code verifies live GitHub protected state and exact candidate evidence bytes without checking out or executing candidate code. Supabase truth remains an independently reviewed evidence assertion and must be re-read by operators before release.");
} catch (error) {
  console.error(`THREADPROOF_TRUSTED_MAIN_PLATFORM_CONTROLS_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
