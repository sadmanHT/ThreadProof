#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PLATFORM_CONTROLS_FORMAT = "threadproof-production-platform-controls/v1";
export const CANONICAL_REPOSITORY = "sadmanHT/ThreadProof";
export const REQUIRED_MAIN_STATUS_CHECK = "ThreadProof Trusted Main Release Guard / trusted-main-release-guard";

const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PROJECT_REF = /^[a-z0-9]{12,40}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const FORBIDDEN_TEXT = /(^|[^a-z])(todo|tbd|placeholder|replace[_ -]?me|dummy|changeme|example)([^a-z]|$)/i;
const FORBIDDEN_VALUE = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|seed phrase|mnemonic phrase|bearer\s+[A-Za-z0-9._-]{12,})/i;
const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ADVISOR_AGE_MS = 24 * 60 * 60 * 1000;
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

function fail(message) {
  throw new Error(`Production platform-controls evidence invalid: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, label, minLength = 1) {
  requireValue(typeof value === "string" && value.trim().length >= minLength, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  requireValue(!FORBIDDEN_VALUE.test(text), `${label} appears to contain secret material.`);
  return text;
}
function isoDate(value, label) {
  const text = cleanText(value, label);
  const millis = Date.parse(text);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text, millis };
}
function sha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function gitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function httpsUrl(value, label) {
  const text = cleanText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(parsed.protocol === "https:", `${label} must use https.`);
  requireValue(!parsed.username && !parsed.password, `${label} must not contain URL credentials.`);
  return text;
}
function opaqueId(value, label) {
  const text = cleanText(value, label, 3);
  requireValue(OPAQUE_ID.test(text), `${label} must be a non-secret opaque identifier.`);
  return text;
}
function evidenceRef(value, label) {
  requireValue(isRecord(value), `${label} is required.`);
  return {
    url: httpsUrl(value.url, `${label}.url`),
    sha256: sha256(value.sha256, `${label}.sha256`),
  };
}
function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
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
function validateBranchControl(value, label, { requireTrustedMain = false } = {}) {
  requireValue(isRecord(value), `${label} is required.`);
  requireValue(value.protected === true, `${label}.protected must be true.`);
  requireValue(value.forcePushAllowed === false, `${label}.forcePushAllowed must be false.`);
  requireValue(value.deletionAllowed === false, `${label}.deletionAllowed must be false.`);
  requireValue(value.requiredStatusChecksEnforced === true, `${label}.requiredStatusChecksEnforced must be true.`);
  requireValue(value.reviewerApprovalEnforced === true, `${label}.reviewerApprovalEnforced must be true.`);
  if (requireTrustedMain) {
    requireValue(value.requiredStatusCheck === REQUIRED_MAIN_STATUS_CHECK, `${label}.requiredStatusCheck must equal ${REQUIRED_MAIN_STATUS_CHECK}.`);
    requireValue(value.upToDateOrMergeQueueEnforced === true, `${label}.upToDateOrMergeQueueEnforced must be true.`);
  }
  evidenceRef(value.evidence, `${label}.evidence`);
}

export function validateProductionPlatformControlsEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  requireValue(evidence.format === PLATFORM_CONTROLS_FORMAT, `format must equal ${PLATFORM_CONTROLS_FORMAT}.`);
  requireValue(evidence.result === "pass", "result must equal pass.");
  requireValue(evidence.environment === "production", "environment must equal production.");

  const releaseVersion = cleanText(evidence.releaseVersion, "releaseVersion");
  requireValue(VERSION.test(releaseVersion), "releaseVersion must be semantic version text such as v1.0.0.");
  if (expected.releaseVersion !== undefined) requireValue(releaseVersion === expected.releaseVersion, "releaseVersion does not match the release manifest.");
  const sourceDevelopCommit = gitSha(evidence.sourceDevelopCommit, "sourceDevelopCommit");
  if (expected.sourceDevelopCommit !== undefined) {
    requireValue(sourceDevelopCommit === gitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceDevelopCommit does not match the release source commit.");
  }

  const observedAt = isoDate(evidence.observedAt, "observedAt");
  let preparedAt;
  if (expected.preparedAt !== undefined) {
    preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(observedAt.millis <= preparedAt.millis, "observedAt must not be after release.preparedAt.");
    requireValue(preparedAt.millis - observedAt.millis <= MAX_OBSERVATION_AGE_MS, "platform-control observation is older than 24 hours at release.preparedAt.");
  }

  requireValue(isRecord(evidence.github), "github section is required.");
  requireValue(evidence.github.repository === CANONICAL_REPOSITORY, `github.repository must equal ${CANONICAL_REPOSITORY}.`);
  validateBranchControl(evidence.github.main, "github.main", { requireTrustedMain: true });
  validateBranchControl(evidence.github.develop, "github.develop");
  requireValue(evidence.github.rulesetReviewCompleted === true, "github.rulesetReviewCompleted must be true.");
  evidenceRef(evidence.github.reviewEvidence, "github.reviewEvidence");

  requireValue(isRecord(evidence.supabase), "supabase section is required.");
  requireValue(evidence.supabase.organization === "ThreadProof", "supabase.organization must equal ThreadProof.");
  const projectRef = cleanText(evidence.supabase.projectRef, "supabase.projectRef");
  requireValue(PROJECT_REF.test(projectRef), "supabase.projectRef must be a lowercase Supabase project reference.");
  if (expected.supabaseProjectRef !== undefined) requireValue(projectRef === expected.supabaseProjectRef, "supabase.projectRef does not match the release manifest.");
  requireValue(evidence.supabase.leakedPasswordProtectionEnabled === true, "supabase.leakedPasswordProtectionEnabled must be true.");
  requireValue(evidence.supabase.leakedPasswordWarningAbsent === true, "supabase.leakedPasswordWarningAbsent must be true.");
  const advisorObservedAt = isoDate(evidence.supabase.securityAdvisorObservedAt, "supabase.securityAdvisorObservedAt");
  requireValue(advisorObservedAt.millis <= observedAt.millis, "supabase.securityAdvisorObservedAt must not be after observedAt.");
  requireValue(observedAt.millis - advisorObservedAt.millis <= MAX_ADVISOR_AGE_MS, "Supabase security-advisor observation is older than 24 hours at observedAt.");
  evidenceRef(evidence.supabase.evidence, "supabase.evidence");

  requireValue(isRecord(evidence.review), "review section is required.");
  const executedBy = opaqueId(evidence.review.executedBy, "review.executedBy");
  requireValue(Array.isArray(evidence.review.reviewerIds) && evidence.review.reviewerIds.length >= 2, "review.reviewerIds must contain at least two reviewers.");
  const reviewers = new Set();
  for (const reviewer of evidence.review.reviewerIds) {
    const reviewerId = opaqueId(reviewer, "review.reviewerIds[]");
    requireValue(!reviewers.has(reviewerId), `reviewer ${reviewerId} is duplicated.`);
    reviewers.add(reviewerId);
  }
  requireValue(!reviewers.has(executedBy) || reviewers.size >= 3, "platform-control evidence should not rely only on the executor reviewing their own evidence.");
  const approvedAt = isoDate(evidence.review.approvedAt, "review.approvedAt");
  requireValue(approvedAt.millis >= observedAt.millis, "review.approvedAt must not predate observedAt.");
  if (preparedAt) requireValue(approvedAt.millis <= preparedAt.millis, "review.approvedAt must not be after release.preparedAt.");
  cleanText(evidence.review.statement, "review.statement", 24);

  if (expected.developBranchProtectionVerified !== undefined) requireValue(expected.developBranchProtectionVerified === true, "release manifest must attest develop branch protection true.");
  if (expected.mainBranchProtectionVerified !== undefined) requireValue(expected.mainBranchProtectionVerified === true, "release manifest must attest main branch protection true.");
  if (expected.supabaseLeakedPasswordProtectionVerified !== undefined) requireValue(expected.supabaseLeakedPasswordProtectionVerified === true, "release manifest must attest Supabase leaked-password protection true.");

  return {
    format: evidence.format,
    result: evidence.result,
    releaseVersion,
    sourceDevelopCommit,
    repository: evidence.github.repository,
    supabaseProjectRef: projectRef,
    observedAt: observedAt.text,
    reviewerCount: reviewers.size,
  };
}

export async function loadAndValidateProductionPlatformControlsEvidence(filePath, expected = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`could not read valid JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateProductionPlatformControlsEvidence(parsed, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidencePath = process.argv[2] ?? process.env.THREADPROOF_PLATFORM_CONTROLS_EVIDENCE_PATH;
  if (!evidencePath) {
    console.error("Usage: node scripts/production-platform-controls-evidence.mjs <platform-controls-evidence.json>");
    process.exit(2);
  }
  loadAndValidateProductionPlatformControlsEvidence(evidencePath, {
    releaseVersion: process.env.THREADPROOF_EXPECTED_RELEASE_VERSION,
    sourceDevelopCommit: process.env.THREADPROOF_EXPECTED_SOURCE_COMMIT,
    preparedAt: process.env.THREADPROOF_EXPECTED_PREPARED_AT,
    supabaseProjectRef: process.env.THREADPROOF_EXPECTED_SUPABASE_PROJECT_REF,
  }).then((summary) => {
    console.log(`Production platform-controls evidence verified: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
