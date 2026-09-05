import { statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import path from "node:path";

const artifactsDir = path.resolve("artifacts");
const wasmPath = path.join(artifactsDir, "CapacitySpend_js", "CapacitySpend.wasm");
const r1csPath = path.join(artifactsDir, "CapacitySpend.r1cs");
const inputPath = path.join(artifactsDir, "valid-input.json");
const witnessPath = path.join(artifactsDir, "CapacitySpend_benchmark.wtns");
const outputPath = path.join(artifactsDir, "CapacitySpend_witness_benchmark.json");

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
}

const started = performance.now();
run(["wtns", "calculate", wasmPath, inputPath, witnessPath]);
const witnessGenerationMs = Math.round((performance.now() - started) * 100) / 100;
run(["wtns", "check", r1csPath, witnessPath]);

const benchmark = {
  schemaVersion: 1,
  format: "threadproof-witness-benchmark/v1",
  circuit: "CapacitySpend",
  circuitVersion: 1,
  measurements: {
    witnessGenerationMs,
    witnessBytes: statSync(witnessPath).size,
  },
  note: "Wall-clock witness generation is measured on the current CI runner from the canonical versioned positive vector input; it is not a production SLO.",
};
writeFileSync(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`);
console.log(`THREADPROOF_WITNESS_BENCHMARK ${JSON.stringify(benchmark)}`);
