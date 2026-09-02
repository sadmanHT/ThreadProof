import { appendFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: packageRoot,
  encoding: "utf8",
});
if (repoRootResult.status !== 0) {
  throw new Error(`Could not resolve repository root: ${repoRootResult.stderr ?? ""}`);
}
const repoRoot = repoRootResult.stdout.trim();
const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
if (headResult.status !== 0) throw new Error(`Could not resolve Git HEAD: ${headResult.stderr ?? ""}`);
const sourceCommit = headResult.stdout.trim();

const localCircomlib = join(packageRoot, "node_modules", "circomlib");
const targetDependency = join("circuits", "poseidon.circom");
const suppliedR1cs = join(packageRoot, "artifacts", "CapacitySpend.r1cs");
const verifierPath = join(scriptDir, "verify-circuit-build.mjs");

if (!existsSync(localCircomlib)) throw new Error(`Expected installed local dependency: ${localCircomlib}`);
if (!existsSync(suppliedR1cs)) throw new Error(`Expected compiled R1CS before dependency tamper probe: ${suppliedR1cs}`);

const tempRoot = mkdtempSync(join(tmpdir(), "threadproof-local-dependency-tamper-"));
const materializedCopy = join(tempRoot, "circomlib-copy");
const backupPath = join(tempRoot, "circomlib-original");
const attestationOut = join(tempRoot, "attestation");
const originalStat = lstatSync(localCircomlib);
const originalSymlinkTarget = originalStat.isSymbolicLink() ? readlinkSync(localCircomlib) : null;

function sha256(path) {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

try {
  cpSync(localCircomlib, materializedCopy, { recursive: true, dereference: true });

  if (originalStat.isSymbolicLink()) {
    rmSync(localCircomlib);
  } else {
    renameSync(localCircomlib, backupPath);
  }
  cpSync(materializedCopy, localCircomlib, { recursive: true });

  const tamperedDependency = join(localCircomlib, targetDependency);
  if (!existsSync(tamperedDependency)) {
    throw new Error(`Expected Circom dependency for tamper probe: ${tamperedDependency}`);
  }
  appendFileSync(tamperedDependency, "\n// THREADPROOF_LOCAL_NODE_MODULES_TAMPER_PROBE\n", "utf8");
  const tamperedSha256 = sha256(tamperedDependency);

  const result = spawnSync(process.execPath, [
    verifierPath,
    "--mode",
    "ci-validation",
    "--circuit",
    "CapacitySpend",
    "--r1cs",
    suppliedR1cs,
    "--out-dir",
    attestationOut,
    "--source-commit",
    sourceCommit,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `Frozen-lockfile build verification failed while local node_modules was tampered:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }

  const attestationPath = join(attestationOut, "CapacitySpend_build_attestation.json");
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  if (attestation.buildVerification?.dependenciesRehydratedFromFrozenLockfile !== true) {
    throw new Error("Attestation did not prove frozen-lockfile dependency rehydration");
  }
  if (attestation.buildVerification?.repositoryNodeModulesIgnored !== true) {
    throw new Error("Attestation did not prove repository node_modules was ignored");
  }
  if (attestation.dependencyInstallation?.repositoryNodeModulesUsed !== false) {
    throw new Error("Attestation claims repository node_modules participated in the build");
  }

  const isolatedPoseidon = attestation.inputs?.circuitClosure?.find(
    (entry) => entry.path === `isolated-node_modules/circomlib/${targetDependency}`,
  );
  if (!isolatedPoseidon) {
    throw new Error("Attested dependency closure is missing isolated circomlib/circuits/poseidon.circom");
  }
  if (isolatedPoseidon.sha256.toLowerCase() === tamperedSha256.toLowerCase()) {
    throw new Error("Tampered repository dependency leaked into the attested isolated dependency closure");
  }

  console.log(
    `THREADPROOF_DEPENDENCY_REHYDRATION_TAMPER_REJECTED ${JSON.stringify({
      sourceCommit,
      tamperedLocalDependency: `packages/circuits/node_modules/circomlib/${targetDependency}`,
      tamperedSha256,
      attestedIsolatedSha256: isolatedPoseidon.sha256,
      repositoryNodeModulesUsed: false,
      r1csReproduced: true,
    })}`,
  );
} finally {
  rmSync(localCircomlib, { recursive: true, force: true });
  if (originalStat.isSymbolicLink()) {
    symlinkSync(originalSymlinkTarget, localCircomlib);
  } else if (existsSync(backupPath)) {
    renameSync(backupPath, localCircomlib);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
