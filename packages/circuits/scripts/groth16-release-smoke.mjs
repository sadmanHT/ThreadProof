import { readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";

const artifactsDir = path.resolve("artifacts");
const r1csPath = path.join(artifactsDir, "CapacityRelease.r1cs");
const witnessPath = path.join(artifactsDir, "release-valid.wtns");
// Reuse the development phase-2 powers of tau produced by the CapacitySpend smoke. This remains
// development-only; production still requires an independently documented ceremony decision.
const potFinal = path.join(artifactsDir, "dev-pot14_final.ptau");
const zkeyInitial = path.join(artifactsDir, "CapacityRelease_dev_0000.zkey");
const zkeyFinal = path.join(artifactsDir, "CapacityRelease_dev_final.zkey");
const verificationKey = path.join(artifactsDir, "release_verification_key.json");
const proofPath = path.join(artifactsDir, "release_proof.json");
const publicPath = path.join(artifactsDir, "release_public.json");
const verifierPath = path.join(artifactsDir, "CapacityReleaseVerifier.sol");
const benchmarkPath = path.join(artifactsDir, "CapacityRelease_benchmark.json");

function run(args) {
  const result = spawnSync("snarkjs", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`snarkjs ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function timed(args) {
  const started = performance.now();
  const output = run(args);
  return { output, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
}

function integerMetric(output, label) {
  const match = output.match(new RegExp(`${label}\\s*:\\s*([0-9]+)`, "i"));
  return match ? Number(match[1]) : null;
}

for (const required of [r1csPath, witnessPath, potFinal]) {
  try {
    statSync(required);
  } catch {
    throw new Error(`Missing ${required}. Run compile:release, test:release:witness, and the CapacitySpend test:groth16 ceremony first.`);
  }
}

const setupStarted = performance.now();
run(["groth16", "setup", r1csPath, potFinal, zkeyInitial]);
run([
  "zkey",
  "contribute",
  zkeyInitial,
  zkeyFinal,
  "--name=ThreadProof CI CapacityRelease development contribution",
  "-e=threadproof-capacity-release-development-only",
]);
run(["zkey", "export", "verificationkey", zkeyFinal, verificationKey]);
const setupMs = Math.round((performance.now() - setupStarted) * 100) / 100;
const prove = timed(["groth16", "prove", zkeyFinal, witnessPath, proofPath, publicPath]);
const verify = timed(["groth16", "verify", verificationKey, publicPath, proofPath]);
if (!verify.output.toLowerCase().includes("ok")) {
  throw new Error(`CapacityRelease Groth16 verification did not report OK:\n${verify.output}`);
}
run(["zkey", "export", "solidityverifier", zkeyFinal, verifierPath]);

const publicSignals = JSON.parse(readFileSync(publicPath, "utf8"));
if (!Array.isArray(publicSignals) || publicSignals.length !== 9) {
  throw new Error(`Expected exactly 9 CapacityRelease public signals, received ${publicSignals.length}`);
}
const verifierSource = readFileSync(verifierPath, "utf8");
if (!verifierSource.includes("verifyProof")) {
  throw new Error("Generated CapacityRelease Solidity verifier does not expose verifyProof");
}

const r1csInfo = run(["r1cs", "info", r1csPath]);
const metrics = {
  format: "threadproof-zk-benchmark/v1",
  circuit: "CapacityRelease",
  measurements: {
    constraints: integerMetric(r1csInfo, "Constraints"),
    wires: integerMetric(r1csInfo, "Wires"),
    labels: integerMetric(r1csInfo, "Labels"),
    privateInputs: integerMetric(r1csInfo, "Private Inputs"),
    publicInputs: integerMetric(r1csInfo, "Public Inputs"),
    publicOutputs: integerMetric(r1csInfo, "Public Outputs"),
    provingMs: prove.elapsedMs,
    verificationMs: verify.elapsedMs,
    developmentSetupMs: setupMs,
    publicSignals: publicSignals.length,
    proofBytes: statSync(proofPath).size,
    verificationKeyBytes: statSync(verificationKey).size,
    verifierSolidityBytes: statSync(verifierPath).size,
  },
  setup: "development-only-groth16",
  note: "Wall-clock values are CI-runner measurements, not protocol constants or production SLOs.",
};

writeFileSync(benchmarkPath, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`THREADPROOF_RELEASE_ZK_SMOKE ${JSON.stringify(metrics)}`);
console.log("CapacityRelease Groth16 development proof generated and verified successfully.");
