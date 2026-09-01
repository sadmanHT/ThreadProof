# ThreadProof Production Groth16 Ceremony

ThreadProof uses Groth16 for `CapacitySpend` and `CapacityRelease`. The repository's normal CI deliberately creates **development-only** proving keys using deterministic test entropy. Those keys are reproducibility fixtures and MUST NOT be registered on a production consortium.

Production requires a separately administered multi-party ceremony for each circuit. This document defines what ThreadProof tooling verifies and what it intentionally does not automate.

## Trust boundary

ThreadProof repository tooling:

- verifies a finalized Powers-of-Tau transcript with `snarkjs powersoftau verify`;
- verifies the final circuit-specific zkey against the exact R1CS and Powers-of-Tau file with `snarkjs zkey verify`;
- confirms the finalized zkey contains at least one Phase-2 contribution;
- exports the public verification key and Solidity verifier from that finalized zkey;
- hashes the R1CS, Powers-of-Tau file, final zkey, verification key, Solidity verifier, and public ceremony-evidence file;
- generates a production provenance wrapper only from evidence marked `mode=production`;
- binds the wrapper to the exact R1CS hash, verification-key hash, and ceremony-evidence SHA-256.

ThreadProof repository tooling MUST NOT:

- generate participant entropy;
- collect contribution secrets;
- accept `--entropy`, seed, private-key, or beacon material;
- persist participant-local secret state;
- claim that CI-generated proving keys are production ceremony artifacts;
- register a verifier on-chain without the existing Charter governance process.

At least one honest Phase-2 contributor is required for Groth16 security. Consortium governance SHOULD use multiple independently administered contributors and a documented final-beacon policy.

## Inputs

For each circuit, the ceremony verification operator needs:

1. the exact `.r1cs` rebuilt from the frozen canonical `develop` source SHA;
2. the consortium-approved finalized Powers-of-Tau `.ptau` file;
3. the finalized circuit-specific `.zkey` after the approved Phase-2 contributions;
4. a public ceremony identifier;
5. the exact 40-hex canonical source commit SHA.

The large `.ptau` and `.zkey` files are intentionally ignored by Git. Store them in the consortium's approved artifact store with independent integrity controls.

## Verify CapacitySpend

From `packages/circuits` after installing the pinned project dependencies and rebuilding the circuit:

```sh
pnpm compile
pnpm ceremony:verify -- \
  --mode production \
  --circuit CapacitySpend \
  --r1cs artifacts/CapacitySpend.r1cs \
  --ptau /secure/public-artifacts/powersOfTau_final.ptau \
  --zkey /secure/public-artifacts/CapacitySpend_final.zkey \
  --out-dir /secure/public-artifacts/threadproof-spend-ceremony \
  --ceremony-id THREADPROOF-SPEND-2026-01 \
  --source-commit <EXACT_TESTED_DEVELOP_SHA> \
  --min-contributions 2
```

The command fails closed if the transcript cannot be verified, the zkey does not match the circuit/PTAU, or the contribution count is below the requested minimum.

## Verify CapacityRelease

```sh
pnpm compile:release
pnpm ceremony:verify -- \
  --mode production \
  --circuit CapacityRelease \
  --r1cs artifacts/CapacityRelease.r1cs \
  --ptau /secure/public-artifacts/powersOfTau_final.ptau \
  --zkey /secure/public-artifacts/CapacityRelease_final.zkey \
  --out-dir /secure/public-artifacts/threadproof-release-ceremony \
  --ceremony-id THREADPROOF-RELEASE-2026-01 \
  --source-commit <EXACT_TESTED_DEVELOP_SHA> \
  --min-contributions 2
```

## Public evidence output

Each verification produces:

- `<Circuit>_verification_key.json`;
- `<Circuit>Verifier.sol`;
- `<Circuit>_ceremony_evidence.json`;
- `<Circuit>_ceremony_evidence.json.sha256`.

The evidence JSON contains only public verification metadata and artifact hashes. It does not contain contributor entropy or participant private material.

Archive the evidence JSON and checksum in the production release evidence store. Copy the evidence URL and SHA-256 into the corresponding `release/production-release.json` verifier entry.

## Generate the production provenance wrapper

Run from `packages/contracts` using the verified public outputs:

```sh
pnpm generate:production-verifier-wrapper -- \
  --circuit CapacitySpend \
  --r1cs ../circuits/artifacts/CapacitySpend.r1cs \
  --verification-key /secure/public-artifacts/threadproof-spend-ceremony/CapacitySpend_verification_key.json \
  --verifier-sol /secure/public-artifacts/threadproof-spend-ceremony/CapacitySpendVerifier.sol \
  --ceremony-evidence /secure/public-artifacts/threadproof-spend-ceremony/CapacitySpend_ceremony_evidence.json \
  --out-dir contracts/generated
```

Repeat with `CapacityRelease` and the release evidence directory.

The generator refuses `ci-validation` evidence. It re-hashes the R1CS, verification key, and Solidity verifier before producing the wrapper. The wrapper exposes:

- `circuitArtifactHash` — Keccak-256 of the exact R1CS;
- `verificationKeyHash` — Keccak-256 of the exact exported verification key;
- `ceremonyEvidenceSha256` — SHA-256 of the public ceremony-evidence JSON.

The first two hashes are the values ThreadProof already records in verifier provenance and validates in `CapacityVault`. The ceremony evidence hash gives the production deployment an additional public audit link to the MPC transcript evidence.

## Governance and deployment

A successful ceremony verification does **not** authorize deployment by itself.

1. Archive the evidence and generated verifier sources.
2. Independently review artifact hashes.
3. Compile the production verifier wrappers using the frozen release source/toolchain.
4. Deploy the verifier contracts through the controlled production deployment process.
5. Verify runtime bytecode and provenance with `verify:production-deployment`.
6. Register the CapacitySpend verifier through the Charter verifier-registration proposal.
7. Register the CapacityRelease verifier through Charter proposal type 14 (`ReleaseVerifierRegistration`).
8. Record proposal IDs, execution transactions, deployed addresses, runtime-code hashes, and ceremony evidence URLs in the production release evidence bundle.

No bootstrap administrator should retain a bypass around Charter verifier governance after production initialization.

## CI validation

CI exercises the same finalized-artifact verifier against the repository's **development-only** proving keys using `mode=ci-validation`. CI-validation evidence cannot be consumed by the production provenance-wrapper generator, and the production release policy continues to require `setup=production-ceremony`.

This separation is intentional: CI proves that the verification tooling works; consortium participants provide the independent entropy and production ceremony trust assumption.
