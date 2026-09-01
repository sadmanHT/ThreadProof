import { readFileSync } from "node:fs";

const harness = readFileSync(new URL("./pilot-fault-resilience.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/qbft-fault-resilience.yml", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../apps/worker/src/chain-runtime.ts", import.meta.url), "utf8");

for (const fragment of [
  'compose("stop", "validator5")',
  'compose("stop", "validator4")',
  'compose("start", "validator4")',
  'compose("start", "validator5")',
  'rpc("eth_chainId")',
  'rpc("eth_blockNumber")',
  'qbft_getValidatorsByBlockNumber',
  'configuredValidatorCount: identity.validatorCount',
  'rpcResponsive',
  'qbft-fault-resilience.json.sha256',
  'result = "pass"',
  'result = "fail"',
]) {
  if (!harness.includes(fragment)) {
    throw new Error(`QBFT fault harness is missing required evidence boundary: ${fragment}`);
  }
}

if (harness.includes('compose("stop", "validator1")')) {
  throw new Error("QBFT fault harness must not stop validator1 because it is the observation RPC endpoint");
}
if (!harness.includes("observedAt !== stalledAt")) {
  throw new Error("QBFT fault harness must require exact no-progress evidence after quorum loss");
}

for (const fragment of [
  "CanonicalBlockProgressMonitor",
  "getBlockNumber()",
  "has not advanced beyond block",
  "responsive RPC as healthy",
  "Math.max(90_000, intervalMs * 3)",
]) {
  if (!runtime.includes(fragment)) {
    throw new Error(`Worker runtime guard is missing canonical stall protection: ${fragment}`);
  }
}

for (const fragment of [
  "push:\n    branches: [develop]",
  "pull_request:\n    branches: [develop]",
  "github.event.pull_request.head.sha || github.sha",
  "pnpm --filter @threadproof/worker test:runtime-readiness",
  "pnpm pilot:fault-resilience",
  "qbft-fault-resilience.json.sha256",
  "if: always()",
  "pnpm pilot:reset",
]) {
  if (!workflow.includes(fragment)) {
    throw new Error(`QBFT fault-resilience workflow is missing canonical evidence control: ${fragment}`);
  }
}

console.log("QBFT fault-resilience trust-boundary checks passed.");
