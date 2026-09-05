import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const vectorPath = path.resolve("vectors/CapacitySpend.v1.json");
const bytes = readFileSync(vectorPath);
const suite = JSON.parse(bytes.toString("utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decimalString(value, label) {
  assert(typeof value === "string" && /^[0-9]+$/.test(value), `${label} must be an unsigned decimal string`);
}

assert(suite.schemaVersion === 1, "CapacitySpend vector schemaVersion must be 1");
assert(suite.format === "threadproof-capacity-spend-vectors/v1", "Unsupported CapacitySpend vector format");
assert(suite.circuit === "CapacitySpend" && suite.circuitVersion === 1, "CapacitySpend vector identity mismatch");
assert(suite.domains?.capacityCommitment === "1", "CapacitySpend capacity commitment domain tag must be 1");
assert(suite.domains?.orderCommitment === "2", "CapacitySpend order commitment domain tag must be 2");
assert(suite.domains?.nullifier === "3", "CapacitySpend nullifier domain tag must be 3");
assert(suite.baseInput && typeof suite.baseInput === "object" && !Array.isArray(suite.baseInput), "baseInput must be an object");

const requiredBaseFields = [
  "factoryId",
  "periodId",
  "processId",
  "orderId",
  "policyHash",
  "previousCapacity",
  "newCapacity",
  "orderWorkload",
  "oldRandomness",
  "newRandomness",
  "orderRandomness",
  "factoryNullifierSecret",
];

for (const field of requiredBaseFields) decimalString(suite.baseInput[field], `baseInput.${field}`);

assert(Array.isArray(suite.cases) && suite.cases.length >= 2, "CapacitySpend vectors require positive and negative cases");
const ids = new Set();
let accepted = 0;
let rejected = 0;
const allowedMutationFields = new Set([
  "oldCapacityCommitment",
  "newCapacityCommitment",
  "orderCommitment",
  "nullifier",
]);

for (const [index, testCase] of suite.cases.entries()) {
  const prefix = `cases[${index}]`;
  assert(typeof testCase.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(testCase.id), `${prefix}.id is invalid`);
  assert(!ids.has(testCase.id), `Duplicate CapacitySpend vector id: ${testCase.id}`);
  ids.add(testCase.id);
  assert(testCase.expected === "accept" || testCase.expected === "reject", `${prefix}.expected must be accept or reject`);
  if (testCase.expected === "accept") accepted += 1;
  else rejected += 1;

  assert(testCase.overrides && typeof testCase.overrides === "object" && !Array.isArray(testCase.overrides), `${prefix}.overrides must be an object`);
  for (const [field, value] of Object.entries(testCase.overrides)) {
    assert(requiredBaseFields.includes(field), `${prefix}.overrides contains unsupported field ${field}`);
    decimalString(value, `${prefix}.overrides.${field}`);
  }

  if (testCase.mutation !== undefined) {
    assert(testCase.mutation && typeof testCase.mutation === "object" && !Array.isArray(testCase.mutation), `${prefix}.mutation must be an object`);
    assert(allowedMutationFields.has(testCase.mutation.field), `${prefix}.mutation.field is unsupported`);
    assert(testCase.mutation.operation === "add", `${prefix}.mutation.operation must be add`);
    decimalString(testCase.mutation.value, `${prefix}.mutation.value`);
  }

  if (testCase.recompute !== undefined) {
    assert(Array.isArray(testCase.recompute), `${prefix}.recompute must be an array`);
    for (const field of testCase.recompute) {
      assert(field === "nullifier", `${prefix}.recompute only supports nullifier`);
    }
  }
}

assert(accepted >= 1, "CapacitySpend vectors require at least one accepted case");
assert(rejected >= 1, "CapacitySpend vectors require at least one rejected case");

for (const requiredId of [
  "valid-base",
  "insufficient-capacity",
  "wrong-subtraction",
  "tampered-old-commitment",
  "tampered-order-commitment",
  "tampered-nullifier",
  "capacity-over-uint64",
]) {
  assert(ids.has(requiredId), `CapacitySpend vectors are missing required case ${requiredId}`);
}

const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(
  `THREADPROOF_VERSIONED_VECTORS ${JSON.stringify({
    circuit: suite.circuit,
    circuitVersion: suite.circuitVersion,
    vectorFile: path.relative(process.cwd(), vectorPath),
    sha256: `0x${sha256}`,
    acceptedCases: accepted,
    rejectedCases: rejected,
  })}`,
);
