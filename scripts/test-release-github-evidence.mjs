#!/usr/bin/env node

import {
  REQUIRED_CANONICAL_WORKFLOWS,
  THREADPROOF_REPOSITORY,
  verifyCanonicalWorkflowEvidence,
} from "./release-github-evidence.mjs";

const sourceDevelopCommit = "a".repeat(40);

function makeRuns() {
  return REQUIRED_CANONICAL_WORKFLOWS.map((workflow, index) => {
    const id = 1000 + index;
    return {
      id,
      name: workflow.name,
      path: workflow.path,
      head_sha: sourceDevelopCommit,
      head_branch: "develop",
      event: "push",
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/${THREADPROOF_REPOSITORY}/actions/runs/${id}`,
      repository: { full_name: THREADPROOF_REPOSITORY },
    };
  });
}

function evidenceUrls(runs) {
  const cleanState = runs.find((run) => run.name === "ThreadProof Clean-State Endgame");
  const qbftFault = runs.find((run) => run.name === "ThreadProof QBFT Fault Resilience");
  return {
    cleanStateRunUrl: cleanState.html_url,
    qbftFaultRunUrl: qbftFault.html_url,
  };
}

function verify(runs, overrides = {}) {
  return verifyCanonicalWorkflowEvidence({
    workflowRuns: runs,
    sourceDevelopCommit,
    repository: THREADPROOF_REPOSITORY,
    ...evidenceUrls(makeRuns()),
    ...overrides,
  });
}

function expectFail(label, callback, expectedMessage) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (expectedMessage && !message.includes(expectedMessage)) {
      throw new Error(`${label} failed for the wrong reason: ${message}`);
    }
    return;
  }
  throw new Error(`${label} should fail.`);
}

const validRuns = makeRuns();
const validUrls = evidenceUrls(validRuns);
const verified = verifyCanonicalWorkflowEvidence({
  workflowRuns: validRuns,
  sourceDevelopCommit,
  repository: THREADPROOF_REPOSITORY,
  ...validUrls,
});
if (verified.length !== REQUIRED_CANONICAL_WORKFLOWS.length) {
  throw new Error("valid canonical evidence did not verify every required workflow.");
}

const missing = makeRuns().filter((run) => run.name !== "ThreadProof Live Subcontract");
expectFail(
  "missing workflow",
  () => verify(missing),
  "ThreadProof Live Subcontract has no successful canonical develop push run",
);

const failed = makeRuns();
failed.find((run) => run.name === "ThreadProof Live PoFC").conclusion = "failure";
expectFail(
  "failed workflow",
  () => verify(failed),
  "ThreadProof Live PoFC has no successful canonical develop push run",
);

const wrongSha = makeRuns();
wrongSha.find((run) => run.name === "ThreadProof CI").head_sha = "b".repeat(40);
expectFail(
  "wrong source SHA",
  () => verify(wrongSha),
  "ThreadProof CI has no successful canonical develop push run",
);

const prEvent = makeRuns();
prEvent.find((run) => run.name === "ThreadProof Endgame Scorecard").event = "pull_request";
expectFail(
  "pull-request evidence",
  () => verify(prEvent),
  "ThreadProof Endgame Scorecard has no successful canonical develop push run",
);

const wrongBranch = makeRuns();
wrongBranch.find((run) => run.name === "ThreadProof Release Policy").head_branch = "main";
expectFail(
  "wrong branch",
  () => verify(wrongBranch),
  "ThreadProof Release Policy has no successful canonical develop push run",
);

const wrongRepository = makeRuns();
wrongRepository.find((run) => run.name === "ThreadProof Live Pilot").repository.full_name = "someone/fork";
expectFail(
  "fork evidence",
  () => verify(wrongRepository),
  "ThreadProof Live Pilot has no successful canonical develop push run",
);

const wrongPath = makeRuns();
wrongPath.find((run) => run.name === "ThreadProof QBFT Fault Resilience").path = ".github/workflows/other.yml";
expectFail(
  "wrong workflow path",
  () => verify(wrongPath),
  "ThreadProof QBFT Fault Resilience has no successful canonical develop push run",
);

const forgedHtmlUrl = makeRuns();
forgedHtmlUrl.find((run) => run.name === "ThreadProof Clean-State Endgame").html_url =
  "https://evidence.threadproof.invalid/actions/runs/1006";
expectFail(
  "forged workflow URL",
  () => verify(forgedHtmlUrl),
  "html_url is not the canonical GitHub Actions run URL",
);

expectFail(
  "mismatched clean-state manifest URL",
  () =>
    verifyCanonicalWorkflowEvidence({
      workflowRuns: makeRuns(),
      sourceDevelopCommit,
      repository: THREADPROOF_REPOSITORY,
      ...validUrls,
      cleanStateRunUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/999999",
    }),
  "evidence.cleanStateRunUrl does not match",
);

expectFail(
  "mismatched QBFT manifest URL",
  () =>
    verifyCanonicalWorkflowEvidence({
      workflowRuns: makeRuns(),
      sourceDevelopCommit,
      repository: THREADPROOF_REPOSITORY,
      ...validUrls,
      qbftFaultRunUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/999998",
    }),
  "evidence.qbftFaultRunUrl does not match",
);

console.log(`Canonical release GitHub evidence checks passed for ${REQUIRED_CANONICAL_WORKFLOWS.length} workflows.`);
