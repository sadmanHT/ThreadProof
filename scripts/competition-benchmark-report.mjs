import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .trim()
  .toLowerCase();
const requestedSourceCommit = (process.env.THREADPROOF_SOURCE_COMMIT ?? sourceCommit).trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(requestedSourceCommit) || requestedSourceCommit !== sourceCommit) {
  throw new Error(`Competition benchmark must run from the exact requested source SHA: HEAD=${sourceCommit}, requested=${requestedSourceCommit}`);
}

const inputs = {
  zk: "packages/circuits/artifacts/CapacitySpend_benchmark.json",
  witness: "packages/circuits/artifacts/CapacitySpend_witness_benchmark.json",
  verifierGas: "packages/circuits/artifacts/CapacitySpend_verifier_gas.json",
  vectors: "packages/circuits/artifacts/witness-tests/vector-results.json",
  contractGas: "artifacts/contract-gas-benchmark.json",
  concurrency: "artifacts/capacity-concurrency-benchmark.json",
  liveQbft: "artifacts/live-qbft-benchmark.json",
  livePofc: "artifacts/live-pofc-benchmark.json",
  qbftFault: "infrastructure/besu/pilot/runtime/qbft-fault-resilience.json",
};

function absolute(relative) {
  return path.join(repoRoot, relative);
}

function readJson(relative) {
  return JSON.parse(readFileSync(absolute(relative), "utf8"));
}

function inputEvidence(relative) {
  const filePath = absolute(relative);
  const bytes = readFileSync(filePath);
  return {
    path: relative,
    sizeBytes: statSync(filePath).size,
    sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

const zk = readJson(inputs.zk);
const witness = readJson(inputs.witness);
const verifierGas = readJson(inputs.verifierGas);
const vectors = readJson(inputs.vectors);
const contractGas = readJson(inputs.contractGas);
const concurrency = readJson(inputs.concurrency);
const liveQbft = readJson(inputs.liveQbft);
const livePofc = readJson(inputs.livePofc);
const qbftFault = readJson(inputs.qbftFault);

if (zk.format !== "threadproof-zk-benchmark/v1" || zk.circuit !== "CapacitySpend") throw new Error("Unexpected CapacitySpend ZK benchmark format");
if (witness.format !== "threadproof-witness-benchmark/v1") throw new Error("Unexpected witness benchmark format");
if (verifierGas.format !== "threadproof-groth16-verifier-gas/v1") throw new Error("Unexpected verifier gas benchmark format");
if (vectors.format !== "threadproof-capacity-spend-vector-results/v1") throw new Error("Unexpected vector result format");
if (contractGas.format !== "threadproof-contract-gas-benchmark/v1") throw new Error("Unexpected contract gas benchmark format");
if (concurrency.format !== "threadproof-capacity-concurrency-benchmark/v1") throw new Error("Unexpected concurrency benchmark format");
if (liveQbft.format !== "threadproof-live-qbft-benchmark/v1") throw new Error("Unexpected live QBFT benchmark format");
if (livePofc.format !== "threadproof-live-pofc-benchmark/v1") throw new Error("Unexpected live PoFC benchmark format");
if (qbftFault.format !== "threadproof-qbft-fault-resilience/v1" || qbftFault.result !== "pass") throw new Error("QBFT fault-resilience evidence did not pass");

for (const [label, evidence] of Object.entries({ verifierGas, concurrency, livePofc, qbftFault })) {
  if (evidence.sourceCommit && String(evidence.sourceCommit).toLowerCase() !== sourceCommit) {
    throw new Error(`${label} evidence is not bound to source commit ${sourceCommit}`);
  }
}

const vectorResults = Array.isArray(vectors.results) ? vectors.results : [];
if (!vectorResults.length || vectorResults.some((entry) => entry.expected === "accept" ? entry.result !== "accepted" : entry.result !== "rejected")) {
  throw new Error("CapacitySpend proof vectors did not all produce their expected result");
}
if (concurrency.sameStateRace?.exactlyOneFinalized !== true || concurrency.sameStateRace?.exactlyOneNullifierConsumed !== true) {
  throw new Error("Same-state concurrency benchmark did not prove exactly-one finalization");
}
if (concurrency.independentKeys?.allFinalized !== true) throw new Error("Independent-key concurrency benchmark did not finalize every spend");
if (livePofc.canonicalStateAdvanced !== true || livePofc.nullifierConsumed !== true) throw new Error("Live PoFC benchmark did not advance canonical state");
const twoDown = qbftFault.observations?.twoValidatorsDown;
if (!twoDown || twoDown.stalledBlock !== twoDown.observedBlock || twoDown.rpcResponsive !== true) {
  throw new Error("QBFT fault evidence did not prove a responsive-but-stalled 3/5 state");
}

const composedEndToEndMs = Math.round(
  (Number(witness.measurements.witnessGenerationMs) +
    Number(zk.measurements.provingMs) +
    Number(livePofc.spendSubmissionToReceiptMs)) *
    100,
) / 100;

const report = {
  schemaVersion: 1,
  format: "threadproof-competition-benchmark-report/v1",
  sourceCommit,
  generatedAt: new Date().toISOString(),
  capacitySpend: {
    circuit: {
      constraints: zk.measurements.constraints,
      wires: zk.measurements.wires,
      privateInputs: zk.measurements.privateInputs,
      publicInputs: zk.measurements.publicInputs,
      witnessGenerationMs: witness.measurements.witnessGenerationMs,
      provingMs: zk.measurements.provingMs,
      verificationMsOffChain: zk.measurements.verificationMs,
      proofBytes: zk.measurements.proofBytes,
      scope: "CapacitySpend v1; development-only Groth16 ceremony on the CI runner",
    },
    verifier: {
      estimateGas: verifierGas.measurements.estimateGas,
      transactionGasUsed: verifierGas.measurements.transactionGasUsed,
      deploymentGasUsed: verifierGas.measurements.deploymentGasUsed,
      calldataBytes: verifierGas.measurements.calldataBytes,
      scope: "Provenance-bound generated Groth16 verifier transaction on disposable chain 2026",
    },
    liveSpend: {
      transactionGasUsed: livePofc.spendGasUsed,
      submissionToReceiptMs: livePofc.spendSubmissionToReceiptMs,
      blockNumber: livePofc.spendBlock,
      canonicalStateAdvanced: livePofc.canonicalStateAdvanced,
      nullifierConsumed: livePofc.nullifierConsumed,
      scope: "Complete CapacityVault PoFC state transition with a real generated Groth16 verifier on disposable five-validator chain 2026",
    },
    composedEndToEndMs: {
      value: composedEndToEndMs,
      components: ["witnessGenerationMs", "provingMs", "liveSpend.submissionToReceiptMs"],
      scope: "Additive measured phases from the same exact-source benchmark run; not a production SLO",
    },
  },
  qbft: {
    validatorTopology: liveQbft.validatorTopology,
    confirmationMs: liveQbft.submissionToReceiptMs,
    confirmationTarget: liveQbft.confirmationTarget,
    oneValidatorDownProgress: qbftFault.observations?.oneValidatorDown ?? null,
    twoValidatorsDownFailClosed: qbftFault.observations?.twoValidatorsDown ?? null,
    quorumRecovery: qbftFault.observations?.quorumRestored ?? null,
  },
  concurrency: {
    independentKeys: {
      ...concurrency.independentKeys,
      scope: "Canonical CapacityVault state-machine throughput on in-process Hardhat with MockCapacitySpendVerifier; excludes Groth16 verification and QBFT network latency",
    },
    sameStateRace: {
      ...concurrency.sameStateRace,
      scope: "Canonical same-predecessor serialization on in-process Hardhat with MockCapacitySpendVerifier; exactly one state transition finalizes",
    },
  },
  proofVectors: {
    acceptedCases: vectorResults.filter((entry) => entry.result === "accepted").length,
    rejectedCases: vectorResults.filter((entry) => entry.result === "rejected").length,
    allExpectedResultsObserved: true,
  },
  contractGasReference: contractGas,
  evidence: Object.fromEntries(
    Object.entries(inputs).map(([key, relative]) => [key, inputEvidence(relative)]),
  ),
  caveats: [
    "The Groth16 setup in this CI benchmark is explicitly development-only and must not be represented as a production trusted setup.",
    "Independent-key and same-state throughput isolate the canonical state machine with a mock verifier; real Groth16 gas and live QBFT confirmation are reported separately.",
    "Wall-clock timings depend on the CI runner and disposable network and are not production service-level objectives.",
  ],
};

const artifactDir = path.join(repoRoot, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const outputPath = path.join(artifactDir, "competition-benchmark-report.json");
const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(outputPath, bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${outputPath}.sha256`, `${sha256}  ${path.basename(outputPath)}\n`);
console.log(`THREADPROOF_COMPETITION_BENCHMARK ${JSON.stringify({ sourceCommit, outputPath, sha256: `0x${sha256}` })}`);
