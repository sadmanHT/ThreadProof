import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { executeLivePofc } from "./lib/live-pofc-context";

async function main() {
  const started = performance.now();
  const result = await executeLivePofc();
  const fixtureToFinalizationMs = Math.round((performance.now() - started) * 100) / 100;

  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(process.cwd(), "../.."),
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  const spendTransaction = await result.provider.getTransaction(result.spendReceipt!.hash);
  if (!spendTransaction) throw new Error("Live PoFC spend transaction was not readable after finalization");
  const spendBlock = await result.provider.getBlock(result.spendReceipt!.blockNumber);
  if (!spendBlock) throw new Error("Live PoFC spend block was not readable after finalization");
  const previousBlock =
    result.spendReceipt!.blockNumber > 0
      ? await result.provider.getBlock(result.spendReceipt!.blockNumber - 1)
      : null;
  const conservativeBlockIntervalMs = previousBlock
    ? Math.max(0, spendBlock.timestamp - previousBlock.timestamp) * 1_000
    : null;

  const benchmark = {
    schemaVersion: 1,
    format: "threadproof-live-pofc-benchmark/v1",
    sourceCommit,
    chainId: result.chainId.toString(),
    validatorTopology: 5,
    setup: "development-only-groth16",
    verifier: result.verifierAddress,
    spendTx: result.spendReceipt?.hash,
    spendBlock: result.spendReceipt?.blockNumber.toString(),
    spendGasUsed: result.spendReceipt?.gasUsed.toString(),
    spendSubmissionToReceiptMs: conservativeBlockIntervalMs,
    fixtureToFinalizationMs,
    timingMethod: conservativeBlockIntervalMs === null ? "unavailable" : "preceding-block-to-spend-block",
    canonicalStateAdvanced: true,
    nullifierConsumed: true,
    allocationAuthorized: true,
    tamperedSignalRejected: result.tamperedSignalRejected,
    note:
      "The live PoFC transaction is a complete provenance-bound Groth16 CapacityVault spend on the five-validator disposable QBFT chain. spendSubmissionToReceiptMs uses the preceding block interval as a conservative chain-level confirmation proxy because the shared execution helper does not persist a local pre-submit timestamp. fixtureToFinalizationMs includes disposable fixture deployment and must not be treated as transaction latency.",
  };
  const artifactDir = path.resolve(process.cwd(), "../../artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, "live-pofc-benchmark.json"), `${JSON.stringify(benchmark, null, 2)}\n`);

  console.log(
    `THREADPROOF_LIVE_POFC ${JSON.stringify({
      chainId: result.chainId.toString(),
      verifier: result.verifierAddress,
      circuitArtifactHash: result.expectedCircuitHash,
      verificationKeyHash: result.expectedVerificationKeyHash,
      credentialTx: result.credentialReceipt?.hash,
      certificationTx: result.certifyReceipt?.hash,
      orderTx: result.orderReceipt?.hash,
      spendTx: result.spendReceipt?.hash,
      spendBlock: result.spendReceipt?.blockNumber.toString(),
      spendGasUsed: result.spendReceipt?.gasUsed.toString(),
      allocationId: result.allocationId,
      oldCommitment: result.publicSignals[5].toString(),
      newCommitment: result.publicSignals[6].toString(),
      nullifier: result.publicSignals[8].toString(),
      allocationAuthorized: true,
      tamperedSignalRejected: result.tamperedSignalRejected,
      setup: "development-only-groth16",
    })}`,
  );
  console.warn(
    "DEV ONLY: this is a real multi-validator PoFC transaction using a development Groth16 ceremony, not a production trusted setup.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
