import { readFileSync } from "node:fs";

const harness = readFileSync(new URL("./pilot-fault-resilience.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/qbft-fault-resilience.yml", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../apps/worker/src/chain-runtime.ts", import.meta.url), "utf8");
const liveStallProbe = readFileSync(new URL("../apps/worker/scripts/live-stalled-chain-readiness.ts", import.meta.url), "utf8");

for (const fragment of [
  'compose("stop", "validator5")',
  'compose("stop", "validator4")',
  'compose("start", "validator4")',
  'compose("restart", ...ACTIVE_QUORUM_VALIDATORS)',
  'compose("start", "validator5")',
  'const ACTIVE_QUORUM_VALIDATORS = ["validator1", "validator2", "validator3", "validator4"]',
  'waitForRpcReady(45_000, "QBFT active-validator restart")',
  'timeoutResetValidators: ACTIVE_QUORUM_VALIDATORS',
  'rpc("eth_chainId")',
  'rpc("eth_blockNumber")',
  'qbft_getValidatorsByBlockNumber',
  'configuredValidatorCount: identity.validatorCount',
  'rpcResponsive',
  'const EVIDENCE_CHECKSUM_PATH = `${EVIDENCE_PATH}.sha256`',
  'writeFile(EVIDENCE_CHECKSUM_PATH',
  'result = "pass"',
  'result = "fail"',
]) {
  if (!harness.includes(fragment)) {
    throw new Error(`QBFT fault harness is missing required evidence boundary: ${fragment}`);
  }
}

if (harness.includes('compose("stop", "validator1")')) {
  throw new Error("QBFT fault harness must not remove validator1 during the fault observation because it is the RPC endpoint");
}
if (!harness.includes("observedAt !== stalledAt")) {
  throw new Error("QBFT fault harness must require exact no-progress evidence after quorum loss");
}
if (!harness.includes("QBFT doubles requesttimeoutseconds on every failed round")) {
  throw new Error("QBFT recovery harness must document why active-validator timer reset is required after quorum loss");
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
  "CanonicalBlockProgressMonitor",
  "getChainId()",
  "getBlockNumber()",
  "THREADPROOF_LIVE_STALLED_CHAIN_FAIL_CLOSED",
  "workerReadinessRejected: true",
  "rpcResponsive: true",
]) {
  if (!liveStallProbe.includes(fragment)) {
    throw new Error(`Live stalled-chain worker probe is missing required fail-closed evidence: ${fragment}`);
  }
}

for (const fragment of [
  "push:\n    branches: [develop]",
  "pull_request:\n    branches: [develop]",
  "github.event.pull_request.head.sha || github.sha",
  "pnpm --filter @threadproof/worker test:runtime-readiness",
  "live-stalled-chain-readiness.ts",
  "pnpm pilot:fault-resilience",
  "qbft-fault-resilience.json.sha256",
  "if: always()",
  "pnpm pilot:reset",
]) {
  if (!workflow.includes(fragment)) {
    throw new Error(`QBFT fault-resilience workflow is missing canonical evidence control: ${fragment}`);
  }
}

const liveProbeIndex = workflow.indexOf("Prove worker fails closed against live stalled QBFT");
const isolationResetIndex = workflow.indexOf("Reset chain after live worker stall proof");
const isolatedBootIndex = workflow.indexOf("Boot isolated chain for full fault recovery");
const isolatedVerifyIndex = workflow.indexOf("Verify isolated five-validator chain");
const fullHarnessIndex = workflow.indexOf("Exercise one-validator tolerance, quorum loss, and recovery");
if (
  liveProbeIndex < 0 ||
  isolationResetIndex <= liveProbeIndex ||
  isolatedBootIndex <= isolationResetIndex ||
  isolatedVerifyIndex <= isolatedBootIndex ||
  fullHarnessIndex <= isolatedVerifyIndex
) {
  throw new Error(
    "QBFT workflow must destroy the live-stall test chain and boot/verify an isolated five-validator chain before the full recovery harness",
  );
}

const pilotUpCount = workflow.split("pnpm pilot:up").length - 1;
if (pilotUpCount < 2) {
  throw new Error("QBFT workflow must boot separate disposable chains for worker-stall and full recovery evidence");
}

console.log("QBFT fault-resilience trust-boundary checks passed.");
