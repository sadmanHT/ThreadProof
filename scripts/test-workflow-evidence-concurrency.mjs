import { readFileSync } from "node:fs";

const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/endgame-scorecard.yml",
  ".github/workflows/release-policy.yml",
  ".github/workflows/pilot-live.yml",
  ".github/workflows/pofc-live.yml",
  ".github/workflows/subcontract-live.yml",
  ".github/workflows/capacity-release-live.yml",
  ".github/workflows/clean-state-endgame.yml",
];

const failures = [];

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

  if (!concurrency.includes("github.event.pull_request.head.sha || github.sha")) {
    failures.push(`${workflowPath}: concurrency must bind to the exact source SHA`);
  }

  if (concurrency.includes("github.event.pull_request.head.ref") || concurrency.includes("github.ref_name")) {
    failures.push(`${workflowPath}: branch-scoped concurrency can cancel canonical release evidence`);
  }

  if (!concurrency.includes("cancel-in-progress: true")) {
    failures.push(`${workflowPath}: duplicate runs for the same event/SHA should remain cancellable`);
  }
}

if (failures.length > 0) {
  console.error("ThreadProof workflow evidence concurrency regression detected:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified exact-SHA concurrency for ${workflows.length} canonical evidence workflows.`);
