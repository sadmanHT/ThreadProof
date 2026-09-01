#!/usr/bin/env node

export const THREADPROOF_REPOSITORY = "sadmanHT/ThreadProof";

export const REQUIRED_CANONICAL_WORKFLOWS = Object.freeze([
  { name: "ThreadProof CI", path: ".github/workflows/ci.yml" },
  { name: "ThreadProof Endgame Scorecard", path: ".github/workflows/endgame-scorecard.yml" },
  { name: "ThreadProof Live Pilot", path: ".github/workflows/pilot-live.yml" },
  { name: "ThreadProof Live PoFC", path: ".github/workflows/pofc-live.yml" },
  { name: "ThreadProof Live Subcontract", path: ".github/workflows/subcontract-live.yml" },
  { name: "ThreadProof Live Capacity Release", path: ".github/workflows/capacity-release-live.yml" },
  { name: "ThreadProof Clean-State Endgame", path: ".github/workflows/clean-state-endgame.yml" },
  { name: "ThreadProof Release Policy", path: ".github/workflows/release-policy.yml" },
  { name: "ThreadProof QBFT Fault Resilience", path: ".github/workflows/qbft-fault-resilience.yml" },
]);

const GIT_SHA = /^[0-9a-fA-F]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalRunUrl(repository, runId) {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function normalizeUrl(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label} is required.`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  requireValue(url.protocol === "https:", `${label} must use https.`);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function verifyCanonicalWorkflowEvidence({
  workflowRuns,
  sourceDevelopCommit,
  repository = THREADPROOF_REPOSITORY,
  cleanStateRunUrl,
  qbftFaultRunUrl,
}) {
  requireValue(Array.isArray(workflowRuns), "workflowRuns must be an array.");
  requireValue(typeof sourceDevelopCommit === "string" && GIT_SHA.test(sourceDevelopCommit), "sourceDevelopCommit must be a full 40-character Git SHA.");
  requireValue(repository === THREADPROOF_REPOSITORY, `release evidence must come from ${THREADPROOF_REPOSITORY}.`);

  const source = sourceDevelopCommit.toLowerCase();
  const eligibleRuns = workflowRuns.filter((run) => {
    if (!run || typeof run !== "object") return false;
    return (
      typeof run.head_sha === "string" &&
      run.head_sha.toLowerCase() === source &&
      run.head_branch === "develop" &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.full_name === repository
    );
  });

  const selected = new Map();
  const selectedIds = new Set();

  for (const requirement of REQUIRED_CANONICAL_WORKFLOWS) {
    const candidates = eligibleRuns
      .filter((run) => run.name === requirement.name && run.path === requirement.path)
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));

    requireValue(candidates.length > 0, `${requirement.name} has no successful canonical develop push run for ${sourceDevelopCommit}.`);

    const run = candidates[0];
    requireValue(Number.isSafeInteger(run.id) && run.id > 0, `${requirement.name} has an invalid run id.`);
    requireValue(!selectedIds.has(run.id), `workflow run ${run.id} is reused across canonical evidence requirements.`);

    const expectedUrl = canonicalRunUrl(repository, run.id);
    const actualUrl = normalizeUrl(run.html_url, `${requirement.name} html_url`);
    requireValue(actualUrl === expectedUrl, `${requirement.name} html_url is not the canonical GitHub Actions run URL.`);

    selected.set(requirement.name, run);
    selectedIds.add(run.id);
  }

  const cleanState = selected.get("ThreadProof Clean-State Endgame");
  const qbftFault = selected.get("ThreadProof QBFT Fault Resilience");

  requireValue(
    normalizeUrl(cleanStateRunUrl, "evidence.cleanStateRunUrl") === canonicalRunUrl(repository, cleanState.id),
    "evidence.cleanStateRunUrl does not match the canonical clean-state run for release.sourceDevelopCommit.",
  );
  requireValue(
    normalizeUrl(qbftFaultRunUrl, "evidence.qbftFaultRunUrl") === canonicalRunUrl(repository, qbftFault.id),
    "evidence.qbftFaultRunUrl does not match the canonical QBFT fault-resilience run for release.sourceDevelopCommit.",
  );

  return REQUIRED_CANONICAL_WORKFLOWS.map(({ name, path }) => {
    const run = selected.get(name);
    return {
      name,
      path,
      runId: run.id,
      url: canonicalRunUrl(repository, run.id),
    };
  });
}
