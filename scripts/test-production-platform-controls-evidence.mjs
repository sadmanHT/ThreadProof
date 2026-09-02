#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const verifier = path.resolve(import.meta.dirname, "verify-release-platform-controls-evidence.mjs");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function evidenceRef(id) {
  return {
    url: `https://evidence.threadproof.invalid/platform-controls/${id}.json`,
    sha256: sha(`platform-controls:${id}`),
  };
}

function branchControl(id, trustedMain = false) {
  const value = {
    protected: true,
    forcePushAllowed: false,
    deletionAllowed: false,
    requiredStatusChecksEnforced: true,
    reviewerApprovalEnforced: true,
    evidence: evidenceRef(id),
  };
  if (trustedMain) {
    value.requiredStatusCheck = "ThreadProof Trusted Main Release Guard / trusted-main-release-guard";
    value.upToDateOrMergeQueueEnforced = true;
  }
  return value;
}

function baseEvidence() {
  return {
    format: "threadproof-production-platform-controls/v1",
    result: "pass",
    environment: "production",
    releaseVersion: "v1.0.0",
    sourceDevelopCommit: "a".repeat(40),
    observedAt: "2026-09-02T11:00:00Z",
    github: {
      repository: "sadmanHT/ThreadProof",
      main: branchControl("github-main", true),
      develop: branchControl("github-develop"),
      rulesetReviewCompleted: true,
      reviewEvidence: evidenceRef("github-ruleset-review"),
    },
    supabase: {
      organization: "ThreadProof",
      projectRef: "mgxthhwzsvlxpsombydb",
      leakedPasswordProtectionEnabled: true,
      leakedPasswordWarningAbsent: true,
      securityAdvisorObservedAt: "2026-09-02T10:55:00Z",
      evidence: evidenceRef("supabase-security-advisor"),
    },
    review: {
      executedBy: "platform-operator-001",
      reviewerIds: ["security-reviewer", "release-reviewer"],
      approvedAt: "2026-09-02T11:05:00Z",
      statement: "Reviewers confirm the sanitized platform-control evidence matches the archived GitHub and Supabase observations for this release.",
    },
  };
}

function baseManifest() {
  return {
    schemaVersion: 1,
    release: {
      version: "v1.0.0",
      sourceDevelopCommit: "a".repeat(40),
      preparedAt: "2026-09-02T11:10:00Z",
    },
    evidence: {
      platformControlsEvidenceUrl: "https://evidence.threadproof.invalid/releases/v1.0.0/platform-controls-evidence.json",
      platformControlsEvidenceSha256: "f".repeat(64),
    },
    externalControls: {
      developBranchProtectionVerified: true,
      mainBranchProtectionVerified: true,
      supabaseLeakedPasswordProtectionVerified: true,
      supabaseProjectRef: "mgxthhwzsvlxpsombydb",
    },
  };
}

function runCase({ mutateEvidence, mutateManifest, tamperAfterHash, symlinkEvidence = false } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "threadproof-platform-controls-"));
  try {
    const evidence = baseEvidence();
    const manifest = baseManifest();
    mutateEvidence?.(evidence);
    mutateManifest?.(manifest);

    const evidencePath = path.join(temp, "docs/releases/v1.0.0/platform-controls-evidence.json");
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (symlinkEvidence) {
      const target = path.join(temp, "actual-platform-controls.json");
      writeFileSync(target, serialized, "utf8");
      symlinkSync(target, evidencePath);
    } else {
      writeFileSync(evidencePath, serialized, "utf8");
    }
    manifest.evidence.platformControlsEvidenceSha256 = sha(serialized);
    tamperAfterHash?.({ evidencePath, evidence, manifest });

    mkdirSync(path.join(temp, "release"), { recursive: true });
    writeFileSync(path.join(temp, "release/production-release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return spawnSync(process.execPath, [verifier], { cwd: temp, encoding: "utf8" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function expectPass(options, label) {
  const result = runCase(options);
  if (result.status !== 0) throw new Error(`${label} should pass.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function expectFail(options, label, needle) {
  const result = runCase(options);
  if (result.status === 0) throw new Error(`${label} should fail.`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (needle && !output.includes(needle)) throw new Error(`${label} failed for the wrong reason.\n${output}`);
}

expectPass({}, "complete release-bound platform-controls evidence");
expectFail({ tamperAfterHash: ({ evidencePath }) => writeFileSync(evidencePath, "{}\n", "utf8") }, "tampered evidence bytes", "does not match release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.releaseVersion = "v1.0.1"; } }, "wrong release version", "does not match the release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.sourceDevelopCommit = "b".repeat(40); } }, "wrong source commit", "does not match the release source commit");
expectFail({ mutateEvidence: (evidence) => { evidence.github.main.protected = false; } }, "unprotected main", "github.main.protected must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.github.develop.protected = false; } }, "unprotected develop", "github.develop.protected must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.github.main.forcePushAllowed = true; } }, "main force-push enabled", "forcePushAllowed must be false");
expectFail({ mutateEvidence: (evidence) => { evidence.github.develop.deletionAllowed = true; } }, "develop deletion enabled", "deletionAllowed must be false");
expectFail({ mutateEvidence: (evidence) => { evidence.github.main.requiredStatusCheck = "ThreadProof CI"; } }, "wrong trusted main status context", "requiredStatusCheck must equal");
expectFail({ mutateEvidence: (evidence) => { evidence.github.main.upToDateOrMergeQueueEnforced = false; } }, "no up-to-date or merge-queue guarantee", "upToDateOrMergeQueueEnforced must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.github.rulesetReviewCompleted = false; } }, "incomplete ruleset review", "rulesetReviewCompleted must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.supabase.leakedPasswordProtectionEnabled = false; } }, "Supabase leaked-password protection disabled", "leakedPasswordProtectionEnabled must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.supabase.leakedPasswordWarningAbsent = false; } }, "Supabase warning present", "leakedPasswordWarningAbsent must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.supabase.projectRef = "differentprojectref"; } }, "wrong Supabase project", "does not match the release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.observedAt = "2026-08-31T11:00:00Z"; evidence.supabase.securityAdvisorObservedAt = "2026-08-31T10:55:00Z"; } }, "stale platform observation", "older than 24 hours");
expectFail({ mutateEvidence: (evidence) => { evidence.supabase.securityAdvisorObservedAt = "2026-08-31T10:55:00Z"; } }, "stale Supabase advisor observation", "security-advisor observation is older than 24 hours");
expectFail({ mutateEvidence: (evidence) => { evidence.review.reviewerIds = ["platform-operator-001", "security-reviewer"]; } }, "executor-only review boundary", "should not rely only on the executor");
expectFail({ mutateEvidence: (evidence) => { evidence.apiKey = "not-a-real-secret-but-forbidden-field"; } }, "secret-bearing field", "forbidden secret-bearing field name");
expectFail({ mutateManifest: (manifest) => { manifest.externalControls.mainBranchProtectionVerified = false; } }, "manifest main protection false", "release manifest must attest main branch protection true");
expectFail({ symlinkEvidence: true }, "symlinked platform-controls evidence", "must not contain symbolic links");

console.log("Production platform-controls evidence policy passed release binding, GitHub/Supabase controls, freshness, reviewer separation, tamper, symlink and secret-safety regressions.");
