import { readFileSync } from "node:fs";

const SOURCE_EXPR = "github.event.pull_request.head.sha || github.sha";
const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/endgame-scorecard.yml",
  ".github/workflows/release-policy.yml",
  ".github/workflows/pilot-live.yml",
  ".github/workflows/pofc-live.yml",
  ".github/workflows/subcontract-live.yml",
  ".github/workflows/capacity-release-live.yml",
  ".github/workflows/clean-state-endgame.yml",
  ".github/workflows/qbft-fault-resilience.yml",
];

const failures = [];
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactRefPattern = new RegExp(
  `ref:\\s*\\$\\{\\{\\s*${escapeRegExp(SOURCE_EXPR)}\\s*\\}\\}`,
  "g",
);
const exactArtifactNamePattern = new RegExp(
  `name:\\s*[^\\n]*\\$\\{\\{\\s*${escapeRegExp(SOURCE_EXPR)}\\s*\\}\\}`,
  "g",
);

for (const workflowPath of workflows) {
  const source = readFileSync(workflowPath, "utf8");
  const concurrency = source.match(/concurrency:\n([\s\S]*?)\n\njobs:/)?.[1] ?? "";

  if (!concurrency) {
    failures.push(`${workflowPath}: missing concurrency block`);
    continue;
  }

  if (!concurrency.includes("github.event_name")) {
    failures.push(`${workflowPath}: concurrency must separate push, pull_request, and dispatch events`);
  }

  if (!concurrency.includes(SOURCE_EXPR)) {
    failures.push(`${workflowPath}: concurrency must bind to the exact source SHA`);
  }

  if (concurrency.includes("github.event.pull_request.head.ref") || concurrency.includes("github.ref_name")) {
    failures.push(`${workflowPath}: branch-scoped concurrency can cancel canonical release evidence`);
  }

  if (!concurrency.includes("cancel-in-progress: true")) {
    failures.push(`${workflowPath}: duplicate runs for the same event/SHA should remain cancellable`);
  }

  const checkoutCount = (source.match(/uses:\s*actions\/checkout@v7/g) ?? []).length;
  const exactCheckoutCount = (source.match(exactRefPattern) ?? []).length;
  if (checkoutCount === 0) {
    failures.push(`${workflowPath}: missing checkout action`);
  } else if (exactCheckoutCount !== checkoutCount) {
    failures.push(
      `${workflowPath}: ${exactCheckoutCount}/${checkoutCount} checkout step(s) bind to the exact source SHA`,
    );
  }

  const uploadCount = (source.match(/uses:\s*actions\/upload-artifact@v7/g) ?? []).length;
  const exactArtifactNameCount = (source.match(exactArtifactNamePattern) ?? []).length;
  if (exactArtifactNameCount !== uploadCount) {
    failures.push(
      `${workflowPath}: ${exactArtifactNameCount}/${uploadCount} uploaded artifact name(s) bind to the exact source SHA`,
    );
  }

  if (/name:\s*[^\n]*\$\{\{\s*github\.sha\s*\}\}/.test(source)) {
    failures.push(`${workflowPath}: raw github.sha must not label release evidence artifacts on pull requests`);
  }
}

const qbftWorkflow = readFileSync(".github/workflows/qbft-fault-resilience.yml", "utf8");
const qbftHarness = readFileSync("scripts/pilot-fault-resilience.mjs", "utf8");
if (!qbftWorkflow.includes(`THREADPROOF_SOURCE_COMMIT: ${{ ${SOURCE_EXPR} }}`)) {
  failures.push("QBFT workflow must pass the resolved exact source commit into the evidence harness");
}
if (!qbftHarness.includes("process.env.THREADPROOF_SOURCE_COMMIT || process.env.GITHUB_SHA || null")) {
  failures.push("QBFT evidence must prefer THREADPROOF_SOURCE_COMMIT over GitHub's merge-ref GITHUB_SHA");
}

if (failures.length > 0) {
  console.error("ThreadProof exact-source workflow evidence regression detected:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Verified exact-source checkout, concurrency, artifact naming, and QBFT source attribution for ${workflows.length} canonical evidence workflows.`,
);
