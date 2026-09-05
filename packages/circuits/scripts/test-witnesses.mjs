import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildPoseidon } from "circomlibjs";

const artifactsDir = path.resolve("artifacts");
const testDir = path.join(artifactsDir, "witness-tests");
const r1csPath = path.join(artifactsDir, "CapacitySpend.r1cs");
const wasmPath = path.join(artifactsDir, "CapacitySpend_js", "CapacitySpend.wasm");
const vectorPath = path.resolve("vectors/CapacitySpend.v1.json");
mkdirSync(testDir, { recursive: true });

const vectorBytes = readFileSync(vectorPath);
const suite = JSON.parse(vectorBytes.toString("utf8"));
if (
  suite.schemaVersion !== 1 ||
  suite.format !== "threadproof-capacity-spend-vectors/v1" ||
  suite.circuit !== "CapacitySpend" ||
  suite.circuitVersion !== 1
) {
  throw new Error("Unsupported or mismatched CapacitySpend vector suite");
}

const poseidon = await buildPoseidon();
const field = poseidon.F;
const domains = {
  capacityCommitment: BigInt(suite.domains.capacityCommitment),
  orderCommitment: BigInt(suite.domains.orderCommitment),
  nullifier: BigInt(suite.domains.nullifier),
};

function hash(inputs) {
  return field.toString(poseidon(inputs.map((value) => BigInt(value))));
}

function decimalRecord(record, label) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        throw new Error(`${label}.${key} must be an unsigned decimal string`);
      }
      return [key, BigInt(value)];
    }),
  );
}

const baseInput = decimalRecord(suite.baseInput, "baseInput");

function recomputeDerived(input) {
  input.oldCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.previousCapacity,
      input.oldRandomness,
      domains.capacityCommitment,
    ]),
  );
  input.newCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.newCapacity,
      input.newRandomness,
      domains.capacityCommitment,
    ]),
  );
  input.orderCommitment = BigInt(
    hash([input.orderId, input.orderWorkload, input.orderRandomness, domains.orderCommitment]),
  );
  input.nullifier = BigInt(
    hash([input.oldCapacityCommitment, input.factoryNullifierSecret, domains.nullifier]),
  );
  return input;
}

function deriveInput(overrides = {}) {
  return recomputeDerived({
    ...baseInput,
    ...decimalRecord(overrides, "overrides"),
  });
}

function applyMutation(input, testCase) {
  if (testCase.mutation) {
    if (testCase.mutation.operation !== "add") {
      throw new Error(`Unsupported mutation operation ${testCase.mutation.operation}`);
    }
    input[testCase.mutation.field] += BigInt(testCase.mutation.value);
  }
  for (const fieldName of testCase.recompute ?? []) {
    if (fieldName !== "nullifier") throw new Error(`Unsupported recompute field ${fieldName}`);
    input.nullifier = BigInt(
      hash([input.oldCapacityCommitment, input.factoryNullifierSecret, domains.nullifier]),
    );
  }
  return input;
}

function toJsonInput(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.toString()]),
  );
}

function runSnarkjs(args) {
  return spawnSync("snarkjs", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
}

function writeInput(name, input) {
  const inputPath = path.join(testDir, `${name}.json`);
  writeFileSync(inputPath, `${JSON.stringify(toJsonInput(input), null, 2)}\n`);
  return inputPath;
}

function calculateAndCheck(name, input) {
  const inputPath = writeInput(name, input);
  const witnessPath = path.join(testDir, `${name}.wtns`);
  const calculate = runSnarkjs(["wtns", "calculate", wasmPath, inputPath, witnessPath]);
  if (calculate.status !== 0) {
    return { valid: false, stage: "calculate", output: `${calculate.stdout}${calculate.stderr}` };
  }

  const check = runSnarkjs(["wtns", "check", r1csPath, witnessPath]);
  if (check.status !== 0) {
    return { valid: false, stage: "check", output: `${check.stdout}${check.stderr}` };
  }

  return { valid: true, witnessPath };
}

const results = [];
let canonicalWritten = false;

for (const testCase of suite.cases) {
  const input = applyMutation(deriveInput(testCase.overrides), testCase);
  const result = calculateAndCheck(testCase.id, input);
  const expectedValid = testCase.expected === "accept";

  if (result.valid !== expectedValid) {
    if (expectedValid) {
      throw new Error(
        `Valid CapacitySpend vector ${testCase.id} was rejected at ${result.stage}:\n${result.output}`,
      );
    }
    throw new Error(`Invalid CapacitySpend vector unexpectedly passed: ${testCase.id}`);
  }

  if (expectedValid && !canonicalWritten) {
    writeFileSync(
      path.join(artifactsDir, "valid-input.json"),
      `${JSON.stringify(toJsonInput(input), null, 2)}\n`,
    );
    const canonicalWitness = path.join(artifactsDir, "valid.wtns");
    const canonicalCalculation = runSnarkjs([
      "wtns",
      "calculate",
      wasmPath,
      path.join(artifactsDir, "valid-input.json"),
      canonicalWitness,
    ]);
    if (canonicalCalculation.status !== 0) {
      throw new Error(
        `Failed to create canonical valid witness:\n${canonicalCalculation.stdout}${canonicalCalculation.stderr}`,
      );
    }
    const canonicalCheck = runSnarkjs(["wtns", "check", r1csPath, canonicalWitness]);
    if (canonicalCheck.status !== 0) {
      throw new Error(
        `Canonical witness failed R1CS check:\n${canonicalCheck.stdout}${canonicalCheck.stderr}`,
      );
    }
    canonicalWritten = true;
  }

  results.push({
    id: testCase.id,
    expected: testCase.expected,
    result: result.valid ? "accepted" : "rejected",
    rejectionStage: result.valid ? null : result.stage,
  });
  console.log(
    result.valid
      ? `Accepted valid witness: ${testCase.id}`
      : `Rejected invalid witness: ${testCase.id} (${result.stage})`,
  );
}

if (!canonicalWritten) throw new Error("CapacitySpend vector suite did not produce a canonical accepted witness");

const vectorSha256 = `0x${createHash("sha256").update(vectorBytes).digest("hex")}`;
const resultManifest = {
  schemaVersion: 1,
  format: "threadproof-capacity-spend-vector-results/v1",
  circuit: "CapacitySpend",
  circuitVersion: 1,
  vectorSource: {
    path: path.relative(process.cwd(), vectorPath).split(path.sep).join("/"),
    sha256: vectorSha256,
  },
  results,
};
writeFileSync(
  path.join(testDir, "vector-results.json"),
  `${JSON.stringify(resultManifest, null, 2)}\n`,
);

const acceptedCount = results.filter((entry) => entry.result === "accepted").length;
const rejectedCount = results.filter((entry) => entry.result === "rejected").length;
console.log(
  `CapacitySpend witness vectors passed: ${acceptedCount} accepted case(s), ${rejectedCount} rejected case(s).`,
);
