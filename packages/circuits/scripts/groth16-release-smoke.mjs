import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

for (const required of [r1csPath, witnessPath, potFinal]) {
  try {
    statSync(required);
  } catch {
    throw new Error(`Missing ${required}. Run compile:release, test:release:witness, and the CapacitySpend test:groth16 ceremony first.`);
  }
}

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
run(["groth16", "prove", zkeyFinal, witnessPath, proofPath, publicPath]);
const verifyOutput = run(["groth16", "verify", verificationKey, publicPath, proofPath]);
if (!verifyOutput.toLowerCase().includes("ok")) {
  throw new Error(`CapacityRelease Groth16 verification did not report OK:\n${verifyOutput}`);
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

console.log(
  `THREADPROOF_RELEASE_ZK_SMOKE ${JSON.stringify({
    publicSignals: publicSignals.length,
    proofBytes: statSync(proofPath).size,
    verificationKeyBytes: statSync(verificationKey).size,
    verifierSolidityBytes: statSync(verifierPath).size,
    setup: "development-only-groth16",
  })}`
);
console.log("CapacityRelease Groth16 development proof generated and verified successfully.");
