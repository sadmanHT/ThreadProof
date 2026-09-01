import fs from "node:fs";
import assert from "node:assert/strict";

const read = (path) => fs.readFileSync(path, "utf8");
const typedData = read("apps/web/lib/subcontract-eip712.ts");
const actions = read("apps/web/app/app/subcontract-actions.ts");
const relayer = read("apps/worker/src/subcontract-relayer.ts");
const migration = read("supabase/migrations/20260901085906_threadproof_subcontract_authorization_workflow.sql");
const privilegeMigration = read("supabase/migrations/20260901091247_threadproof_subcontract_browser_privilege_hardening.sql");

const expectedFields = [
  "parentOrderId",
  "childOrderId",
  "parentFactoryOrganizationId",
  "subcontractorOrganizationId",
  "periodId",
  "processId",
  "policyHash",
  "parentVersionHash",
  "childVersionHash",
  "complianceCredentialId",
  "processCredentialId",
  "capacityAllocationId",
  "sequence",
  "nonce",
  "deadline",
];

for (const field of expectedFields) {
  assert.match(typedData, new RegExp(`name: \\"${field}\\"`), `typed data must include ${field}`);
  assert.match(relayer, new RegExp(`name: \\"${field}\\"`), `relayer must recover the same ${field} field`);
}

assert.match(typedData, /name:\s*"ThreadProof SubcontractGovernor"/);
assert.match(typedData, /version:\s*"1"/);
assert.match(typedData, /primaryType:\s*"SubcontractAuthorization"/);
assert.match(relayer, /name:\s*"ThreadProof SubcontractGovernor"/);
assert.match(relayer, /version:\s*"1"/);
assert.match(relayer, /primaryType:\s*"SubcontractAuthorization"/);

for (const forbidden of [
  "quantity",
  "confidential_payload_ciphertext",
  "encrypted_remaining_capacity",
  "encrypted_randomness",
  "capacity_commitment",
  "buyer_signature",
]) {
  assert.doesNotMatch(typedData, new RegExp(forbidden), `private operational field ${forbidden} must not enter signed subcontract payload`);
}

assert.match(actions, /requireConsortiumViewer\(\)/);
assert.match(actions, /hasOperationalRole\(membership\)/);
assert.match(actions, /isCapacityAllocationAuthorized/);
assert.match(actions, /isCredentialValidFor/);
assert.match(actions, /simulateContract\(\{[\s\S]*functionName:\s*"authorizeSubcontract"/);
assert.match(actions, /organizationOfAccount/);
assert.match(actions, /isActiveAccount/);
assert.match(actions, /nonces/);

assert.match(relayer, /persistBroadcast/);
assert.match(relayer, /reconcileSubmittedJobs/);
assert.match(relayer, /SubcontractAuthorized/);
assert.match(relayer, /SUBCONTRACT_EVENT_MISMATCH/);
assert.doesNotMatch(relayer, /status:\s*"confirmed"[\s\S]{0,240}waitForTransactionReceipt/, "receipt observation must not be the canonical confirmation boundary");

assert.match(migration, /alter table public\.subcontract_authorization_jobs enable row level security/);
assert.match(migration, /subcontract_jobs_parent_factory_insert/);
assert.match(migration, /subcontract_jobs_parent_factory_sign/);
assert.match(privilegeMigration, /revoke select on public\.subcontract_authorization_jobs from authenticated/);
const selectGrant = privilegeMigration.match(/grant select \(([\s\S]*?)\) on public\.subcontract_authorization_jobs to authenticated;/)?.[1];
assert.ok(selectGrant, "authenticated SELECT whitelist must be explicit");
assert.doesNotMatch(selectGrant, /worker_claim_token/);
assert.doesNotMatch(selectGrant, /worker_claimed_at/);
assert.doesNotMatch(selectGrant, /parent_factory_signature/);
assert.match(selectGrant, /\bid\b/);
assert.match(selectGrant, /\bstatus\b/);

console.log(JSON.stringify({
  threadproof_subcontract_contract_tests: "PASS",
  signed_fields: expectedFields,
  canonical_confirmation: "SubcontractAuthorized indexed event",
}));
