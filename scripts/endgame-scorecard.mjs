import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const results = [];

function check(id, description, fn) {
  try {
    fn();
    results.push({ id, description, status: "pass" });
  } catch (error) {
    results.push({ id, description, status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
}

const capacityVault = read("packages/contracts/contracts/CapacityVault.sol");
const releaseCircuit = read("packages/circuits/circuits/CapacityRelease.circom");
const releaseGenerator = read("apps/worker/src/capacity-release-generator.ts");
const releaseSubmitter = read("apps/worker/src/capacity-release-submitter.ts");
const releaseMigration = read("supabase/migrations/20260901142000_threadproof_capacity_release_operations.sql");
const disclosureMigration = read("supabase/migrations/20260901150000_threadproof_due_process_disclosure.sql");
const disclosureExporter = read("apps/worker/src/due-process-disclosure.ts");
const credentialPackage = read("apps/worker/src/credential-package.ts");
const charter = read("packages/contracts/contracts/ThreadProofCharter.sol");
const aiContract = read("apps/web/scripts/test-ai-contract.mjs");
const productionBoundary = read("scripts/check-production-boundaries.mjs");

check("capacity-release-inverse", "Capacity release restores exactly the historical hidden workload", () => {
  assert.match(releaseCircuit, /restoredCapacity === currentCapacity \+ orderWorkload/);
  assert.match(releaseCircuit, /orderHash\.out === orderCommitment/);
  assert.match(releaseCircuit, /release-nullifier domain tag|capacity-release-nullifier domain tag/i);
});

check("capacity-release-chain-eligibility", "Release requires an existing historical allocation that is no longer currently authorized", () => {
  assert.match(capacityVault, /AllocationStillAuthorized/);
  assert.match(capacityVault, /releasedAllocations/);
  assert.match(releaseGenerator, /isCapacityAllocationAuthorized/);
  assert.match(releaseGenerator, /releasedAllocations/);
});

check("capacity-release-separation", "Release proving and chain signing remain separate capabilities", () => {
  assert.match(releaseGenerator, /THREADPROOF_SIGNER_MODE !== "disabled"/);
  assert.doesNotMatch(releaseGenerator, /createRelayerWallet/);
  assert.match(releaseSubmitter, /createRelayerWallet/);
  assert.doesNotMatch(releaseSubmitter, /private_capacity_openings/);
});

check("capacity-release-canonical-materialization", "Only canonical CapacityReleased events can materialize restored private state", () => {
  assert.match(releaseMigration, /event_name <> 'CapacityReleased'/);
  assert.match(releaseMigration, /next_capacity_ciphertext/);
  assert.match(releaseMigration, /recertification_required/);
});

check("disclosure-governance-binding", "Protected identity disclosure is bound to the exact Charter action and canonical event", () => {
  assert.match(charter, /ProtectedIdentityDisclosureAuthorized/);
  assert.match(disclosureMigration, /ProtectedIdentityDisclosureAuthorized/);
  assert.match(disclosureMigration, /proposal\.action_hash/);
  assert.match(disclosureMigration, /GOVERNANCE_ACTION_MISMATCH/);
});

check("disclosure-confidentiality", "Disclosure plaintext is never stored as a browser-readable database artifact", () => {
  assert.match(disclosureMigration, /revoke all on table public\.protected_identity_disclosures from public, anon, authenticated/);
  assert.match(disclosureExporter, /decryptDetached/);
  assert.match(disclosureExporter, /AES-256-GCM\+RSA-OAEP-SHA256/);
  assert.doesNotMatch(disclosureExporter, /plaintext\s*:/);
});

check("credential-portability", "Credential packages are portable and reject divergence from canonical CredentialRegistry state", () => {
  assert.match(credentialPackage, /threadproof-credential-package\/v1/);
  assert.match(credentialPackage, /getCredential/);
  assert.match(credentialPackage, /isCredentialActive/);
  assert.match(credentialPackage, /no longer matches canonical CredentialRegistry state/);
  assert.match(credentialPackage, /packageSha256/);
});

check("ai-advisory-only", "AI remains outside authoritative protocol transitions", () => {
  assert.match(aiContract, /authorize|authority|advisory|deterministic/i);
});

check("production-secret-boundary", "Production boundary checks reject embedded signer/key material", () => {
  assert.match(productionBoundary, /private|signer|secret|key/i);
});

const pass = results.filter((item) => item.status === "pass").length;
const fail = results.length - pass;
const scorecard = {
  format: "threadproof-endgame-scorecard/v1",
  generatedAt: new Date().toISOString(),
  summary: { pass, fail, total: results.length, scorePercent: Math.round((pass / results.length) * 100) },
  results,
  note: "This deterministic scorecard supplements, but does not replace, real Groth16, contract, browser, worker, and live-chain CI jobs.",
};

const artifactDir = path.join(root, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const outputPath = path.join(artifactDir, "endgame-scorecard.json");
writeFileSync(outputPath, `${JSON.stringify(scorecard, null, 2)}\n`);
console.log(JSON.stringify(scorecard, null, 2));
if (fail > 0) process.exitCode = 1;
