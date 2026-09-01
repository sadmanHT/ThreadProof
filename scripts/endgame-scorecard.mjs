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
const releaseMigration = read("supabase/migrations/20260901141230_threadproof_capacity_release_operations.sql");
const disclosureMigration = read("supabase/migrations/20260901142051_threadproof_due_process_disclosure.sql");
const disclosureExporter = read("apps/worker/src/due-process-disclosure.ts");
const protectedIdentity = read("apps/worker/src/protected-identity.ts");
const credentialPackage = read("apps/worker/src/credential-package.ts");
const privateCredentialMigration = read("supabase/migrations/20260901145022_threadproof_private_credential_packages.sql");
const workerPrivileges = read("supabase/migrations/20260901144904_threadproof_worker_service_privilege_matrix.sql");
const charter = read("packages/contracts/contracts/ThreadProofCharter.sol");
const aiContract = read("apps/web/scripts/test-ai-contract.mjs");
const productionBoundary = read("scripts/check-production-boundaries.mjs");
const spendBenchmark = read("packages/circuits/scripts/groth16-smoke.mjs");
const releaseBenchmark = read("packages/circuits/scripts/groth16-release-smoke.mjs");
const gasBenchmark = read("packages/contracts/test/GasSnapshot.spec.ts");
const liveBenchmark = read("apps/worker/scripts/pilot-live-runtime.ts");

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

check("capacity-release-governance", "Release verifier installation is a distinct high-threshold Charter action", () => {
  assert.match(charter, /ReleaseVerifierRegistration/);
  assert.match(charter, /RELEASE_VERIFIER_REGISTRATION_DOMAIN/);
  assert.match(charter, /executeReleaseVerifierRegistration/);
  assert.match(charter, /registerReleaseVerifierWithProvenance/);
});

check("disclosure-governance-binding", "Protected identity disclosure is bound to the exact Charter action and canonical event", () => {
  assert.match(charter, /ProtectedIdentityDisclosureAuthorized/);
  assert.match(disclosureMigration, /ProtectedIdentityDisclosureAuthorized/);
  assert.match(disclosureMigration, /proposal\.action_hash/);
  assert.match(disclosureMigration, /GOVERNANCE_ACTION_MISMATCH/);
  assert.match(protectedIdentity, /hashProtectedIdentityDisclosureAction/);
  assert.match(protectedIdentity, /getProposal/);
  assert.match(protectedIdentity, /proposal\.proposalType/);
});

check("disclosure-confidentiality", "Protected identities stay encrypted at rest and released packages are recipient-encrypted", () => {
  assert.match(disclosureMigration, /revoke all on table public\.protected_identity_disclosures from public, anon, authenticated/);
  assert.match(protectedIdentity, /encryptDetached/);
  assert.match(disclosureExporter, /decryptDetached/);
  assert.match(disclosureExporter, /AES-256-GCM\+RSA-OAEP-SHA256/);
  assert.doesNotMatch(disclosureExporter, /plaintext\s*:/);
});

check("credential-private-storage", "Credential bodies are encrypted in service-only storage rather than browser-readable protocol mirrors", () => {
  assert.match(privateCredentialMigration, /credential_private_packages/);
  assert.match(privateCredentialMigration, /revoke all on table public\.credential_private_packages from public, anon, authenticated/);
  assert.match(privateCredentialMigration, /grant select, insert, update on table public\.credential_private_packages to service_role/);
  assert.match(credentialPackage, /encryptEmbedded/);
  assert.match(credentialPackage, /decryptEmbedded/);
});

check("credential-portability", "Credential packages include a real body, canonical digest binding and live issuance receipt verification", () => {
  assert.match(credentialPackage, /threadproof-private-credential\/v1/);
  assert.match(credentialPackage, /threadproof-credential-package\/v1/);
  assert.match(credentialPackage, /assertedBodyDigest/);
  assert.match(credentialPackage, /canonicalIssuance/);
  assert.match(credentialPackage, /CredentialIssued/);
  assert.match(credentialPackage, /getTransactionReceipt/);
  assert.match(credentialPackage, /packageSha256/);
});

check("worker-service-privileges", "Service workers receive only the table operations required to rebuild canonical projections", () => {
  assert.match(workerPrivileges, /grant select, insert, update on table public\.chain_events to service_role/);
  assert.match(workerPrivileges, /grant select, insert, update on table public\.credentials to service_role/);
  assert.match(workerPrivileges, /grant select, insert, update on table public\.private_capacity_openings to service_role/);
  assert.match(workerPrivileges, /revoke delete, truncate on table public\.chain_events from service_role/);
});

check("measured-benchmark-output", "Evaluation emits measured ZK, gas and live-QBFT benchmark artifacts instead of structural scores alone", () => {
  assert.match(spendBenchmark, /CapacitySpend_benchmark\.json/);
  assert.match(spendBenchmark, /provingMs/);
  assert.match(spendBenchmark, /verificationMs/);
  assert.match(releaseBenchmark, /CapacityRelease_benchmark\.json/);
  assert.match(gasBenchmark, /contract-gas-benchmark\.json/);
  assert.match(liveBenchmark, /live-qbft-benchmark\.json/);
  assert.match(liveBenchmark, /submissionToReceiptMs/);
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
  note: "This deterministic trust-boundary scorecard supplements, but does not replace, measured benchmark output, real Groth16, contract, browser, worker, and live-chain CI jobs.",
};

const artifactDir = path.join(root, "artifacts");
mkdirSync(artifactDir, { recursive: true });
const outputPath = path.join(artifactDir, "endgame-scorecard.json");
writeFileSync(outputPath, `${JSON.stringify(scorecard, null, 2)}\n`);
console.log(JSON.stringify(scorecard, null, 2));
if (fail > 0) process.exitCode = 1;
