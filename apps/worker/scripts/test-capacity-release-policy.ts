import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const generator = readFileSync(path.join(root, "apps/worker/src/capacity-release-generator.ts"), "utf8");
const submitter = readFileSync(path.join(root, "apps/worker/src/capacity-release-submitter.ts"), "utf8");
const migration = readFileSync(path.join(root, "supabase/migrations/20260901142000_threadproof_capacity_release_operations.sql"), "utf8");

assert.match(generator, /THREADPROOF_SIGNER_MODE !== "disabled"/, "release prover must reject transaction-signing capability");
assert.match(generator, /getCapacityAllocation/, "release prover must read the canonical allocation receipt");
assert.match(generator, /releasedAllocations/, "release prover must reject already released allocations");
assert.match(generator, /isCapacityAllocationAuthorized/, "release prover must require the historical allocation to be non-current");
assert.match(generator, /currentCapacity \+ orderWorkload/, "release prover must reconstruct the exact inverse private capacity transition");
assert.match(generator, /releaseNullifierSecret/, "release prover must use the release-domain nullifier witness");

assert.match(submitter, /simulateContract/, "release submitter must simulate against the canonical chain before broadcast");
assert.match(submitter, /releaseCapacity/, "release submitter must call CapacityVault.releaseCapacity");
assert.match(submitter, /waiting for canonical CapacityReleased indexing/, "release receipt must not materialize private state directly");
assert.doesNotMatch(submitter, /private_capacity_openings/, "release submitter must never mutate private capacity openings");

assert.match(migration, /if new\.event_name <> 'CapacityReleased'/, "only canonical CapacityReleased events may drive reconciliation");
assert.match(migration, /next_capacity_ciphertext/, "canonical event reconciliation must require the staged encrypted restored opening");
assert.match(migration, /status = 'recertification_required'|status='recertification_required'/, "missing or mismatched private release state must fail closed");
assert.match(migration, /revoke all on table public\.capacity_release_jobs from public, anon, authenticated/, "release jobs must not be browser-readable");

console.log("Capacity release worker trust-boundary checks passed.");
