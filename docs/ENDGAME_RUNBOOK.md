# ThreadProof Endgame Runbook

This runbook is the reproducibility contract for the ThreadProof endgame. It starts from a clean checkout, rebuilds both ZK circuits, boots a disposable five-validator Besu/QBFT consortium on chain `2026`, and executes the live trust paths without relying on a developer laptop or persistent chain state.

## What this proves

A successful clean-state rehearsal demonstrates all of the following on the exact Git commit under test:

1. The web application typechecks and produces a production build.
2. Worker signer policy and runtime trust-boundary tests pass.
3. Smart contracts compile and their adversarial tests pass.
4. `CapacitySpend` and `CapacityRelease` are compiled from source with pinned Circom `2.2.0`.
5. Canonical and adversarial witnesses are exercised for both circuits.
6. Real Groth16 proofs are generated and locally verified.
7. Generated verifier contracts are provenance-bound to the exact circuit artifacts.
8. A fresh five-validator chain `2026` boots from generated QBFT topology.
9. A PoFC-backed subcontract authorization completes on the live disposable chain.
10. A PoFC spend, order cancellation, and cryptographic capacity release complete on the live disposable chain.
11. The deterministic endgame scorecard passes and is preserved as an artifact.

This rehearsal does **not** make application databases or AI outputs authoritative. Canonical protocol state remains the signed/verified chain state. Supabase stores encrypted operational state, queues, read models, and canonical-event projections.

## CI path

Use the GitHub Actions workflow **ThreadProof Clean-State Endgame**. It runs on pull requests to `develop` and can also be started manually with `workflow_dispatch`.

Treat the workflow's exact `github.sha` as the verification unit. Do not transfer a green result from a different commit.

The workflow always destroys its disposable pilot network and uploads the scorecard plus spend/release proof and provenance artifacts.

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

Boot and exercise a fresh consortium:

```bash
pnpm pilot:reset
pnpm pilot:prepare
pnpm pilot:up
pnpm pilot:verify

set -a
. infrastructure/besu/pilot/runtime/pilot.env
set +a
export THREADPROOF_GENERATED_PROOF_DIR="$PWD/packages/circuits/artifacts"

pnpm --filter @threadproof/contracts verify:live-subcontract --network threadproofLocal
pnpm --filter @threadproof/contracts verify:live-capacity-release --network threadproofLocal
pnpm pilot:verify
pnpm pilot:reset
```

## Hosted Supabase verification

Hosted Supabase is not reset by the clean-state chain workflow. After schema changes, verify separately that:

- newly introduced operational tables have RLS enabled;
- browser roles have no grants to confidential service-only queues/receipts;
- `service_role` is never exposed to browser code;
- security advisors do not report newly introduced high-severity issues;
- Auth leaked-password protection is enabled at the platform level when the project plan supports it.

The `capacity_release_jobs` and `protected_identity_disclosures` tables are designed as service-only operational surfaces. They must remain unreadable by `anon` and `authenticated`.

## Production key boundary

Production and staging transaction writers must use the remote signer mode. Raw relayer private keys are development-only and are rejected by runtime validation outside development.

Do not commit any of the following:

- `.env` files other than `.env.example`;
- PEM/private key material;
- Besu/Web3Signer runtime keys;
- Supabase service-role keys;
- Gemini or other provider API secrets.

## Due-Process Disclosure

A protected identity may be exported only after an exact canonical `ProtectedIdentityDisclosureAuthorized` Charter event is indexed and matches the staged proposal action hash, subject reference, and evidence hash.

The exporter decrypts the protected identity in server memory only and immediately envelope-encrypts it to a recipient RSA public key using AES-256-GCM + RSA-OAEP-SHA256. The resulting package contains chain authorization evidence, recipient-key fingerprint, and a deterministic package hash; plaintext is not written back to Supabase.

## Credential packages

Use the worker credential-package tool to export or verify portable credential packages:

```bash
pnpm --filter @threadproof/worker credential:package -- export <credentialId> <output.json>
pnpm --filter @threadproof/worker credential:package -- verify <output.json>
```

Verification re-reads `CredentialRegistry.getCredential` and `isCredentialActive`; a package that diverges from canonical chain state is rejected.

## Release criteria

A commit is a release candidate only when all mandatory GitHub workflows for that **exact SHA** are green, including standard CI, live PoFC/subcontract/release checks, the clean-state rehearsal, and the endgame scorecard. Platform controls such as branch protection and Supabase Auth settings must be verified separately because repository code cannot substitute for them.
