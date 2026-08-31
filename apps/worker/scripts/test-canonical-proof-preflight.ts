import assert from "node:assert/strict";
import type { Hex } from "viem";
import {
  assertCapacityStateMatches,
  StaleCanonicalCapacityError,
  type CanonicalCapacityState,
  type ExpectedCapacityOpening,
} from "../src/canonical-capacity.js";

const factory = `0x${"11".repeat(32)}` as Hex;
const period = `0x${"22".repeat(32)}` as Hex;
const processId = `0x${"33".repeat(32)}` as Hex;
const credential = `0x${"44".repeat(32)}` as Hex;
const policy = `0x${"55".repeat(32)}` as Hex;

const expected: ExpectedCapacityOpening = {
  factoryOrganizationId: factory,
  periodId: period,
  processId,
  activeCommitment: 123456789n,
  capacityCredentialId: credential,
  policyHash: policy,
  circuitVersion: 7,
};

const state: CanonicalCapacityState = {
  activeCommitment: expected.activeCommitment,
  capacityCredentialId: credential,
  policyHash: policy,
  circuitVersion: expected.circuitVersion,
  updatedAt: 1n,
  active: true,
};

assert.doesNotThrow(() => assertCapacityStateMatches(state, expected));

function stale(overrides: Partial<CanonicalCapacityState>, pattern: RegExp) {
  assert.throws(
    () => assertCapacityStateMatches({ ...state, ...overrides }, expected),
    (error: unknown) => {
      assert.ok(error instanceof StaleCanonicalCapacityError);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

stale({ active: false }, /inactive/i);
stale({ activeCommitment: 987654321n }, /commitment/i);
stale({ capacityCredentialId: `0x${"66".repeat(32)}` as Hex }, /credential/i);
stale({ policyHash: `0x${"77".repeat(32)}` as Hex }, /policy/i);
stale({ circuitVersion: 8 }, /circuit version/i);

console.log("Canonical capacity proof preflight checks passed");
