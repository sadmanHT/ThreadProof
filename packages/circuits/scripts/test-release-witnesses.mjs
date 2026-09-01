import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildPoseidon } from "circomlibjs";

const artifactsDir = path.resolve("artifacts");
const testDir = path.join(artifactsDir, "release-witness-tests");
const r1csPath = path.join(artifactsDir, "CapacityRelease.r1cs");
const wasmPath = path.join(artifactsDir, "CapacityRelease_js", "CapacityRelease.wasm");
mkdirSync(testDir, { recursive: true });

const poseidon = await buildPoseidon();
const field = poseidon.F;

function hash(inputs) {
  return field.toString(poseidon(inputs.map((value) => BigInt(value))));
}

function deriveInput(overrides = {}) {
  const input = {
    factoryId: 101n,
    periodId: 202610n,
    processId: 1n,
    orderId: 7001n,
    policyHash: 9001n,
    currentCapacity: 1_260_000n,
    restoredCapacity: 1_800_000n,
    orderWorkload: 540_000n,
    currentRandomness: 222_222n,
    restoredRandomness: 555_555n,
    orderRandomness: 333_333n,
    releaseNullifierSecret: 777_777n,
    ...overrides,
  };

  input.oldCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.currentCapacity,
      input.currentRandomness,
      1n,
    ])
  );
  input.newCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.restoredCapacity,
      input.restoredRandomness,
      1n,
    ])
  );
  input.orderCommitment = BigInt(
    hash([input.orderId, input.orderWorkload, input.orderRandomness, 2n])
  );
  input.nullifier = BigInt(
    hash([
      input.oldCapacityCommitment,
      input.orderCommitment,
      input.releaseNullifierSecret,
      4n,
    ])
  );

  return input;
}

function toJsonInput(input) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.toString()]));
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

const validInput = deriveInput();
const validResult = calculateAndCheck("valid-release", validInput);
if (!validResult.valid) {
  throw new Error(`Valid CapacityRelease witness was rejected at ${validResult.stage}:\n${validResult.output}`);
}

writeFileSync(
  path.join(artifactsDir, "release-valid-input.json"),
  `${JSON.stringify(toJsonInput(validInput), null, 2)}\n`
);
const canonicalWitness = path.join(artifactsDir, "release-valid.wtns");
const canonicalCalculation = runSnarkjs([
  "wtns",
  "calculate",
  wasmPath,
  path.join(artifactsDir, "release-valid-input.json"),
  canonicalWitness,
]);
if (canonicalCalculation.status !== 0) {
  throw new Error(`Failed to create canonical CapacityRelease witness:\n${canonicalCalculation.stdout}${canonicalCalculation.stderr}`);
}
const canonicalCheck = runSnarkjs(["wtns", "check", r1csPath, canonicalWitness]);
if (canonicalCheck.status !== 0) {
  throw new Error(`Canonical CapacityRelease witness failed R1CS check:\n${canonicalCheck.stdout}${canonicalCheck.stderr}`);
}

const invalidCases = [
  {
    name: "wrong-addition",
    input: deriveInput({ restoredCapacity: 1_799_999n }),
  },
  {
    name: "tampered-current-commitment",
    mutate(input) {
      input.oldCapacityCommitment += 1n;
      input.nullifier = BigInt(hash([
        input.oldCapacityCommitment,
        input.orderCommitment,
        input.releaseNullifierSecret,
        4n,
      ]));
      return input;
    },
  },
  {
    name: "tampered-restored-commitment",
    mutate(input) {
      input.newCapacityCommitment += 1n;
      return input;
    },
  },
  {
    name: "tampered-order-commitment",
    mutate(input) {
      input.orderCommitment += 1n;
      input.nullifier = BigInt(hash([
        input.oldCapacityCommitment,
        input.orderCommitment,
        input.releaseNullifierSecret,
        4n,
      ]));
      return input;
    },
  },
  {
    name: "tampered-release-nullifier",
    mutate(input) {
      input.nullifier += 1n;
      return input;
    },
  },
  {
    name: "restored-capacity-over-uint64",
    input: deriveInput({
      currentCapacity: (1n << 64n) - 100n,
      orderWorkload: 200n,
      restoredCapacity: (1n << 64n) + 100n,
    }),
  },
];

for (const testCase of invalidCases) {
  const input = testCase.input ?? testCase.mutate(deriveInput());
  const result = calculateAndCheck(testCase.name, input);
  if (result.valid) {
    throw new Error(`Invalid CapacityRelease witness unexpectedly passed: ${testCase.name}`);
  }
  console.log(`Rejected invalid CapacityRelease witness: ${testCase.name} (${result.stage})`);
}

console.log(
  `CapacityRelease witness tests passed: 1 valid witness accepted, ${invalidCases.length} invalid witnesses rejected.`
);
