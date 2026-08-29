import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildPoseidon } from "circomlibjs";

const artifactsDir = path.resolve("artifacts");
const testDir = path.join(artifactsDir, "witness-tests");
const r1csPath = path.join(artifactsDir, "CapacitySpend.r1cs");
const wasmPath = path.join(artifactsDir, "CapacitySpend_js", "CapacitySpend.wasm");
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
    previousCapacity: 1_800_000n,
    newCapacity: 1_260_000n,
    orderWorkload: 540_000n,
    oldRandomness: 111_111n,
    newRandomness: 222_222n,
    orderRandomness: 333_333n,
    factoryNullifierSecret: 444_444n,
    ...overrides,
  };

  input.oldCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.previousCapacity,
      input.oldRandomness,
      1n,
    ])
  );
  input.newCapacityCommitment = BigInt(
    hash([
      input.factoryId,
      input.periodId,
      input.processId,
      input.policyHash,
      input.newCapacity,
      input.newRandomness,
      1n,
    ])
  );
  input.orderCommitment = BigInt(
    hash([input.orderId, input.orderWorkload, input.orderRandomness, 2n])
  );
  input.nullifier = BigInt(
    hash([input.oldCapacityCommitment, input.factoryNullifierSecret, 3n])
  );

  return input;
}

function toJsonInput(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.toString()])
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

const validInput = deriveInput();
const validResult = calculateAndCheck("valid", validInput);
if (!validResult.valid) {
  throw new Error(`Valid CapacitySpend witness was rejected at ${validResult.stage}:\n${validResult.output}`);
}

// Keep a canonical positive witness/input for the Groth16 smoke test.
writeFileSync(
  path.join(artifactsDir, "valid-input.json"),
  `${JSON.stringify(toJsonInput(validInput), null, 2)}\n`
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
  throw new Error(`Failed to create canonical valid witness:\n${canonicalCalculation.stdout}${canonicalCalculation.stderr}`);
}
const canonicalCheck = runSnarkjs(["wtns", "check", r1csPath, canonicalWitness]);
if (canonicalCheck.status !== 0) {
  throw new Error(`Canonical witness failed R1CS check:\n${canonicalCheck.stdout}${canonicalCheck.stderr}`);
}

const invalidCases = [
  {
    name: "insufficient-capacity",
    input: deriveInput({ previousCapacity: 1_000n, orderWorkload: 1_001n, newCapacity: 0n }),
  },
  {
    name: "wrong-subtraction",
    input: deriveInput({ newCapacity: 1_260_001n }),
  },
  {
    name: "tampered-old-commitment",
    mutate(input) {
      input.oldCapacityCommitment += 1n;
      input.nullifier = BigInt(hash([input.oldCapacityCommitment, input.factoryNullifierSecret, 3n]));
      return input;
    },
  },
  {
    name: "tampered-order-commitment",
    mutate(input) {
      input.orderCommitment += 1n;
      return input;
    },
  },
  {
    name: "tampered-nullifier",
    mutate(input) {
      input.nullifier += 1n;
      return input;
    },
  },
  {
    name: "capacity-over-uint64",
    input: deriveInput({
      previousCapacity: 1n << 64n,
      newCapacity: 1n << 64n,
      orderWorkload: 0n,
    }),
  },
];

for (const testCase of invalidCases) {
  const input = testCase.input ?? testCase.mutate(deriveInput());
  const result = calculateAndCheck(testCase.name, input);
  if (result.valid) {
    throw new Error(`Invalid CapacitySpend witness unexpectedly passed: ${testCase.name}`);
  }
  console.log(`Rejected invalid witness: ${testCase.name} (${result.stage})`);
}

console.log(
  `CapacitySpend witness tests passed: 1 valid witness accepted, ${invalidCases.length} invalid witnesses rejected.`
);
