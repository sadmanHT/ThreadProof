import { createPublicClient, http } from "viem";
import {
  CanonicalBlockProgressMonitor,
  ChainRuntimeReadinessError,
} from "../src/chain-runtime.js";

const rpcUrl = process.env.THREADPROOF_FAULT_RPC_URL ?? "http://127.0.0.1:8545";
const expectedChainId = Number(process.env.THREADPROOF_FAULT_CHAIN_ID ?? "2026");
const stallThresholdMs = Number(process.env.THREADPROOF_FAULT_STALL_THRESHOLD_MS ?? "15000");
const pollIntervalMs = Number(process.env.THREADPROOF_FAULT_POLL_INTERVAL_MS ?? "2000");

for (const [label, value] of [
  ["expected chain ID", expectedChainId],
  ["stall threshold", stallThresholdMs],
  ["poll interval", pollIntervalMs],
] as const) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

const client = createPublicClient({
  transport: http(rpcUrl, { timeout: 5_000, retryCount: 1, retryDelay: 200 }),
});
const progress = new CanonicalBlockProgressMonitor(stallThresholdMs);
const startedAt = Date.now();
let observations = 0;
let firstBlock: bigint | undefined;
let lastBlock: bigint | undefined;

while (Date.now() - startedAt <= stallThresholdMs + 30_000) {
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) {
    throw new Error(`Live stalled-chain probe connected to chain ${chainId}; expected ${expectedChainId}.`);
  }

  const blockNumber = await client.getBlockNumber();
  firstBlock ??= blockNumber;
  lastBlock = blockNumber;
  observations += 1;

  try {
    progress.observe(blockNumber);
  } catch (error) {
    if (
      error instanceof ChainRuntimeReadinessError &&
      /has not advanced beyond block/i.test(error.message) &&
      /responsive RPC/i.test(error.message)
    ) {
      console.log(
        `THREADPROOF_LIVE_STALLED_CHAIN_FAIL_CLOSED ${JSON.stringify({
          result: "pass",
          chainId,
          firstBlock: firstBlock.toString(),
          lastBlock: blockNumber.toString(),
          observations,
          stallThresholdMs,
          elapsedMs: Date.now() - startedAt,
          rpcResponsive: true,
          workerReadinessRejected: true,
        })}`,
      );
      process.exit(0);
    }
    throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}

throw new Error(
  `Worker readiness did not reject the live stalled chain within the expected window; ` +
    `observed ${firstBlock?.toString() ?? "none"} -> ${lastBlock?.toString() ?? "none"}.`,
);
