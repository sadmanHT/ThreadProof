# ThreadProof Endgame Runbook

This runbook is the reproducibility contract for the ThreadProof endgame. It starts from a clean checkout, rebuilds both ZK circuits, boots a disposable five-validator Besu/QBFT consortium on chain `2026`, executes the live trust paths, injects validator failures, and preserves measured evidence without relying on a developer laptop or persistent chain state.

## What this proves

A successful clean-state rehearsal plus fault-resilience run demonstrates all of the following on the exact Git commit under test:

1. The web application typechecks and produces a production build.
2. Worker signer policy and runtime trust-boundary tests pass.
3. Smart contracts compile and their adversarial tests pass.
4. `CapacitySpend` and `CapacityRelease` are compiled from source with pinned Circom `2.2.0`.
5. Canonical and adversarial witnesses are exercised for both circuits.
6. Real Groth16 proofs are generated and locally verified.
7. Generated verifier contracts are provenance-bound to the exact circuit artifacts.
8. A fresh five-validator chain `2026` boots from generated QBFT topology.
9. A worker-signed transaction is submitted to the five-validator network and its receipt latency/gas are measured.
10. A PoFC-backed subcontract authorization completes on the live disposable chain.
11. A PoFC spend, order cancellation, and cryptographic capacity release complete on the live disposable chain.
12. Five-validator QBFT remains live with one validator unavailable, stops finalizing with two unavailable while RPC remains responsive, and resumes after quorum restoration.
13. Workers fail closed when a canonical RPC responds but block height stops advancing beyond the configured stall threshold.
14. The deterministic endgame trust-boundary scorecard passes.
15. Measured gas, R1CS, proof-size, proving/verification-time, live-QBFT, and QBFT-fault artifacts are preserved.

This rehearsal does **not** make application databases or AI outputs authoritative. Canonical protocol state remains signed/verified chain state. Supabase stores encrypted operational state, queues, read models, and canonical-event projections.

## CI path

Use the GitHub Actions workflows **ThreadProof Clean-State Endgame** and **ThreadProof QBFT Fault Resilience**. They run on pull requests to `develop`, on canonical `develop` pushes, and can also be started manually with `workflow_dispatch`.

Treat the workflow's exact source SHA as the verification unit. Do not transfer a green result from a different commit.

A release-candidate source is considered technically attested only when all nine workflows for the same exact source SHA are green:

- ThreadProof CI
- ThreadProof Live PoFC
- ThreadProof Live Subcontract
- ThreadProof Live Capacity Release
- ThreadProof Live Pilot
- ThreadProof Endgame Scorecard
- ThreadProof Clean-State Endgame
- ThreadProof Release Policy
- ThreadProof QBFT Fault Resilience

The clean-state workflow always destroys its disposable pilot network and uploads the scorecard, measured benchmark files, spend/release proofs, verification keys, and verifier-provenance artifacts. The fault-resilience workflow independently uploads a sanitized JSON observation record and SHA-256 checksum for the validator-loss/recovery experiment.

## Local reproduction

Prerequisites:

- Node.js 22
- pnpm 10.15.0
- Docker with Compose v2
- Rust/Cargo
- enough disk and CPU to compile Circom and produce Groth16 development proofs

From a clean checkout:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter @threadproof/web typecheck
pnpm --filter @threadproof/web build
pnpm --filter @threadproof/worker typecheck
pnpm --filter @threadproof/worker test:signer-policy
pnpm --filter @threadproof/contracts typecheck
pnpm --filter @threadproof/contracts compile
pnpm --filter @threadproof/contracts test
node scripts/check-production-boundaries.mjs
node scripts/endgame-scorecard.mjs
```

Install the exact compiler revision used by CI:

```bash
cargo install \
  --git https://github.com/iden3/circom.git \
  --rev 9fd40a34f42912ee52230f8b6a114d78f6df1a48 \
  --locked \
  --root /tmp/threadproof-circom \
  circom
export PATH="/tmp/threadproof-circom/bin:$PATH"
circom --version
```

Rebuild cryptographic artifacts from source:

```bash
rm -rf packages/circuits/artifacts packages/contracts/contracts/generated
pnpm --filter @threadproof/circuits test
pnpm --filter @threadproof/circuits compile
pnpm --filter @threadproof/circuits compile:release
pnpm --filter @threadproof/circuits test:witness
pnpm --filter @threadproof/circuits test:release:witness
pnpm --filter @threadproof/circuits test:groth16
pnpm --filter @threadproof/circuits test:release:groth16

mkdir -p packages/contracts/contracts/generated
cp packages/circuits/artifacts/CapacitySpendVerifier.sol packages/contracts/contracts/generated/CapacitySpendVerifier.sol
cp packages/circuits/artifacts/CapacityReleaseVerifier.sol packages/contracts/contracts/generated/CapacityReleaseVerifier.sol
THREADPROOF_GENERATED_PROOF_DIR="$PWD/packages/circuits/artifacts" node packages/contracts/scripts/generate-verifier-provenance-wrapper.mjs
THREADPROOF_GENERATED_PROOF_DIR="$PWD/packages/circuits/artifacts" node packages/contracts/scripts/generate-release-verifier-provenance-wrapper.mjs
```

Boot, deploy, measure and exercise a fresh consortium:

```bash
pnpm pilot:reset
pnpm pilot:prepare
pnpm pilot:up
pnpm pilot:verify

set -a
. infrastructure/besu/pilot/runtime/pilot.env
set +a
export THREADPROOF_DEPLOYMENT_OUTPUT_PATH="$PWD/infrastructure/besu/pilot/runtime/deployment.json"
export THREADPROOF_GENERATED_PROOF_DIR="$PWD/packages/circuits/artifacts"

pnpm --filter @threadproof/contracts deploy:local --network threadproofLocal
pnpm --filter @threadproof/worker test:pilot-live
pnpm --filter @threadproof/contracts verify:live-subcontract --network threadproofLocal
pnpm --filter @threadproof/contracts verify:live-capacity-release --network threadproofLocal
pnpm pilot:verify
pnpm pilot:reset
```

Run the independent QBFT liveness/fail-closed experiment from a fresh disposable network:

```bash
pnpm pilot:up
pnpm --filter @threadproof/worker test:runtime-readiness
pnpm pilot:fault-resilience
pnpm pilot:reset
```

The fault harness deliberately keeps validator1 running as the observation RPC endpoint, stops validator5 and requires 4/5 finalization to continue, then stops validator4 and requires a settled no-progress window while `eth_chainId` still answers. Restoring validator4 must restore block progress; restoring validator5 must leave the full network advancing. See `docs/QBFT_FAULT_RESILIENCE.md`.

## Measured evaluation artifacts

The endgame evidence contains measurements rather than inferred performance claims:

- `artifacts/contract-gas-benchmark.json` — representative contract gas on the in-process Hardhat network. The mock-verifier spend measurement is explicitly labeled and does not pretend to include real Groth16 verifier cost.
- `packages/circuits/artifacts/CapacitySpend_benchmark.json` — R1CS counts, proof/VK/verifier sizes, proving time, verification time and development-ceremony time.
- `packages/circuits/artifacts/CapacityRelease_benchmark.json` — the corresponding release-circuit measurements.
- `artifacts/live-qbft-benchmark.json` — one-confirmation submission-to-receipt latency and gas for a worker-signed zero-value transaction on the disposable five-validator chain.
- `artifacts/endgame-scorecard.json` — deterministic structural/trust-boundary checks. This is not a latency or throughput benchmark.
- `infrastructure/besu/pilot/runtime/qbft-fault-resilience.json` plus `.sha256` — exact block-height/timing observations for 5/5, 4/5, no-quorum 3/5, and recovery states. It contains no validator keys or private protocol data.

Wall-clock measurements vary with the CI runner and must not be presented as protocol constants or production SLOs.

## Hosted Supabase verification

Hosted Supabase is not reset by the clean-state chain workflow. After schema changes, verify separately that:

- repository migration filenames exactly match the versions recorded by hosted Supabase;
- newly introduced operational tables have RLS enabled;
- service-only tables have explicit browser-deny RLS policies and no browser table grants;
- `service_role` receives only the SELECT/INSERT/UPDATE operations required by the worker implementation;
- destructive service DELETE/TRUNCATE operations remain denied on confidential protocol mirrors;
- `service_role` is never exposed to browser code;
- security/performance advisors do not report newly introduced actionable issues;
- Auth leaked-password protection is enabled at the platform level when the project plan supports it.

`capacity_release_jobs`, `encrypted_supplier_identities`, `protected_identity_disclosures`, and `credential_private_packages` are service-only operational surfaces. They must remain unreadable by `anon` and `authenticated`.

## Production key boundary

Production and staging transaction writers must use remote signer mode. Raw relayer private keys are development-only and are rejected by runtime validation outside development.

Do not commit any of the following:

- `.env` files other than `.env.example`;
- PEM/private key material;
- Besu/Web3Signer runtime keys;
- Supabase service-role keys;
- Gemini or other provider API secrets.

## Due-Process Disclosure

Protected identity material is operated through the service-only worker command:

```bash
pnpm --filter @threadproof/worker protected:identity -- seal <identity-input.json>
pnpm --filter @threadproof/worker protected:identity -- stage <encryptedIdentityId> <proposalId> <subjectReference> <evidenceHash>
```

`seal` AES-GCM encrypts the identity before database storage. `stage` reads the actual `ThreadProofCharter` proposal from canonical RPC, recomputes `hashProtectedIdentityDisclosureAction(subjectReference,evidenceHash)`, requires proposal type `4`, rejects cancelled proposals, and stores only the resulting action commitment and encrypted-identity reference.

A protected identity may be exported only after the exact canonical `ProtectedIdentityDisclosureAuthorized` Charter event is indexed and matches the staged proposal action hash, subject reference, and evidence hash.

The exporter decrypts the protected identity in server memory only and immediately envelope-encrypts it to a recipient RSA public key using AES-256-GCM + RSA-OAEP-SHA256. The resulting package contains chain authorization evidence, recipient-key fingerprint, and a deterministic package hash; plaintext is not written back to Supabase.

## Real credential packages

A portable credential package is not created from metadata alone. First seal a private credential body whose declared digest binding matches the canonical `CredentialRegistry` record:

```bash
pnpm --filter @threadproof/worker credential:package -- seal <credentialId> <credential-body.json>
pnpm --filter @threadproof/worker credential:package -- export <credentialId> <output.json>
pnpm --filter @threadproof/worker credential:package -- verify <output.json>
```

The private body uses `format: "threadproof-private-credential/v1"`, W3C-style `@context`/`type`/`issuer` presentation fields, an exact canonical `anchor`, and one of two explicit digest bindings:

- `keccak256-canonical-json-v1` — the canonical digest is `keccak256` of the stable canonical JSON body. This is suitable only for credentials issued with that exact digest convention.
- `threadproof-capacity-credential-v1` — reconstructs ThreadProof's existing structured Capacity Credential digest from credential ID, subject/issuer organizations, period, process, policy, commitment, scope, methodology, validity and circuit version. The body explicitly notes which fields are chain-digest-bound versus package-integrity protected.

The sealed body is AES-256-GCM encrypted in `credential_private_packages`; only service-role processes can read it. `export` decrypts the body only in memory, rechecks the body digest, current credential state, and the actual `CredentialIssued` transaction receipt/block/log on canonical RPC. The resulting file is written mode `0600`.

`verify` requires only the package and canonical RPC. It rechecks the package SHA-256, credential-body SHA-256, body digest binding, `CredentialRegistry.getCredential`, `isCredentialActive`, the issuance receipt's canonical block hash, and the exact `CredentialIssued` event. Old fixture rows with no issuance transaction hash intentionally fail closed and must be re-indexed or re-issued before portable export.

## Capacity release verifier governance

Spend-verifier and release-verifier registration are distinct Charter actions. Release verifier registration is proposal type `14` and is appended after the existing proposal IDs so proposal types `1` through `13` retain their historical meanings.

Release-verifier installation requires the same supermajority shape as spend-verifier registration: four constituencies, mandatory Auditor + Regulator participation, exact artifact/VK action-hash binding and a one-day timelock. Direct deployer/bootstrap verifier-admin authority must be retired before production governance is considered established.

## Recovery boundary

Read models and job queues are operational state and may be rebuilt from canonical events. Private commitment openings are different: they contain witness material that cannot be reconstructed from public chain data.

If a private capacity opening is lost or cannot open the current on-chain commitment:

1. stop proof generation for that factory × period × process key;
2. preserve the current on-chain commitment and event history;
3. do not manufacture replacement `(R, ρ)` values in PostgreSQL;
4. use the approved auditor/Charter recovery or recertification path to retire/freeze the affected state and initialize replacement capacity explicitly;
5. resume only after the replacement state is canonically established.

If Supabase/read models are lost while the chain remains healthy, restore encrypted organization-owned backups for non-public private documents and rebuild chain-derived projections from canonical events. A database restore must never overwrite newer canonical chain state.

## Release criteria

A commit is a release candidate only when all nine mandatory GitHub workflows for that **exact SHA** are green, the hosted Supabase migration history matches Git, and the Supabase advisors show no new actionable database issues.

Production release still has two platform controls that repository code cannot manufacture:

1. protect `main` and `develop` with required checks/rulesets;
2. enable Supabase Auth leaked-password protection.

Do not describe those two controls as complete until the platform settings themselves are verified.
