# ThreadProof Production Groth16 Ceremony

ThreadProof uses Groth16 for `CapacitySpend` and `CapacityRelease`. The repository's normal CI deliberately creates **development-only** proving keys using deterministic test entropy. Those keys are reproducibility fixtures and MUST NOT be registered on a production consortium.

Production requires a separately administered multi-party ceremony for each circuit. This document defines what ThreadProof tooling verifies and what it intentionally does not automate.

## Trust boundary

ThreadProof repository tooling:

- requires production verification to run from the exact named Git source commit with no tracked working-tree modifications;
- independently recompiles the selected circuit before accepting ceremony artifacts;
- requires the freshly rebuilt R1CS SHA-256 to equal the supplied ceremony R1CS SHA-256;
- records the exact Git tree, recursive Circom include closure, `pnpm-lock.yaml`, circuit package manifest, Circom binary hash, required Circom version, and pinned Circom source revision in a circuit-build attestation;
- verifies a finalized Powers-of-Tau transcript with `snarkjs powersoftau verify`;
- verifies the final circuit-specific zkey against that build-verified R1CS and Powers-of-Tau file with `snarkjs zkey verify`;
- requires production verification to explicitly declare `--min-contributions` with a value of at least 2, while CI-validation retains its development-only single-contribution default;
- rejects a finalized zkey whose verified Phase-2 contribution count is below that declared minimum;
- exports the public verification key and Solidity verifier from that finalized zkey;
- hashes the build attestation, R1CS, Powers-of-Tau file, final zkey, verification key, Solidity verifier, and public ceremony-evidence file;
- generates a production provenance wrapper only from evidence marked `mode=production` that records a successful clean-source circuit recompilation;
- binds the wrapper to the exact R1CS hash, verification-key hash, build-attestation SHA-256, and ceremony-evidence SHA-256.

ThreadProof repository tooling MUST NOT:

- generate participant entropy;
- collect contribution secrets;
- accept `--entropy`, seed, private-key, or beacon material;
- persist participant-local secret state;
- claim that CI-generated proving keys are production ceremony artifacts;
- register a verifier on-chain without the existing Charter governance process.

Groth16 security requires at least one honest Phase-2 contributor. ThreadProof's production policy deliberately sets a stronger operational floor: at least two verified Phase-2 contributions must be required by the verification command, and consortium governance should use multiple independently administered contributors plus a documented final-beacon policy. The numeric floor does **not** prove that contributors were independent, honest, or separately administered; participant identity/custody remains governance evidence outside this verifier.

The build attestation proves that, at verification time, the supplied R1CS byte hash matched a fresh compilation from the exact clean Git HEAD using the recorded dependency closure and compiler binary. It does **not** by itself prove how the Circom compiler binary was originally built or that every external package registry was honest. The pinned compiler source revision, compiler-binary hash, frozen lockfile, recursive dependency hashes, and reproducible re-run are the review boundary for that toolchain risk.

## Inputs

For each circuit, the ceremony verification operator needs:

1. the exact `.r1cs` produced for the frozen canonical `develop` source SHA;
2. the consortium-approved finalized Powers-of-Tau `.ptau` file;
3. the finalized circuit-specific `.zkey` after the approved Phase-2 contributions;
4. a public ceremony identifier;
5. the exact 40-hex canonical source commit SHA;
6. an explicit production Phase-2 contribution threshold of at least 2;
7. the pinned Circom 2.2.0 compiler installed from revision `9fd40a34f42912ee52230f8b6a114d78f6df1a48` and project dependencies installed from the frozen lockfile.

The large `.ptau` and `.zkey` files are intentionally ignored by Git. Store them in the consortium's approved artifact store with independent integrity controls.

Before production verification, checkout exactly the tested source SHA, install dependencies with the frozen lockfile, install the pinned Circom compiler, and confirm `git status --porcelain --untracked-files=no` is empty. Generated untracked artifact files are allowed; tracked source modifications are not.

## Verify CapacitySpend

From `packages/circuits` after installing the pinned project dependencies and building the circuit:

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

Before checking the transcript/zkey, the command invokes `verify-circuit-build.mjs`, recompiles `CapacitySpend` into a disposable directory, and requires the rebuilt R1CS to be byte-hash identical to `artifacts/CapacitySpend.r1cs`. It fails closed if the named source SHA differs from the actual Git HEAD, tracked source is dirty, Circom is not 2.2.0, includes cannot be resolved, or the rebuilt R1CS differs.

Production mode also fails closed before reading ceremony artifacts if `--min-contributions` is omitted or set below 2. It then fails closed if the Powers-of-Tau transcript cannot be verified, the zkey does not match the verified circuit/PTAU, or the verified contribution count is below the explicitly requested minimum.

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

The same clean-source recompilation and explicit multi-contributor production floor apply to `CapacityRelease`.

## Public evidence output

Each verification produces:

- `build-verification/<Circuit>_build_attestation.json`;
- `build-verification/<Circuit>_build_attestation.json.sha256`;
- `<Circuit>_verification_key.json`;
- `<Circuit>Verifier.sol`;
- `<Circuit>_ceremony_evidence.json`;
- `<Circuit>_ceremony_evidence.json.sha256`.

The build attestation records only public reproducibility material: source/tree identifiers, compiler/version hashes, dependency/include hashes, lockfile/package hashes, and rebuilt/supplied artifact hashes. The ceremony evidence contains only public verification metadata and artifact hashes, including the verified contribution count and required minimum. Neither contains contributor entropy or participant private material.

Archive both evidence JSON files and checksums in the production release evidence store. The ceremony evidence hashes the build attestation, so the ceremony record is cryptographically linked to the exact source-to-R1CS verification run. Copy the ceremony evidence URL and SHA-256 into the corresponding `release/production-release.json` verifier entry.

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

The generator refuses `ci-validation` evidence and refuses production evidence that does not record the clean-source circuit recompilation boundary or pinned Circom revision. It re-hashes the R1CS, verification key, and Solidity verifier before producing the wrapper. The wrapper exposes:

- `circuitArtifactHash` — Keccak-256 of the exact R1CS;
- `verificationKeyHash` — Keccak-256 of the exact exported verification key;
- `buildAttestationSha256` — SHA-256 of the clean-source build-attestation JSON;
- `ceremonyEvidenceSha256` — SHA-256 of the public ceremony-evidence JSON.

The R1CS and verification-key hashes are the values ThreadProof already records in verifier provenance and validates in `CapacityVault`. The build and ceremony evidence hashes give the deployed production verifier explicit public links to the source-build verification and MPC transcript evidence.

## Governance and deployment

A successful ceremony verification does **not** authorize deployment by itself.

1. Archive the build attestation, ceremony evidence, checksums, and generated verifier sources.
2. Independently reproduce the build attestation from the exact source SHA and review artifact hashes.
3. Review the public ceremony record, verified contribution count, participant administration evidence, and final-beacon policy; the numeric contribution floor alone is not evidence of contributor independence.
4. Compile the production verifier wrappers using the frozen release source/toolchain.
5. Deploy the verifier contracts through the controlled production deployment process.
6. Verify runtime bytecode and provenance with `verify:production-deployment`.
7. Register the CapacitySpend verifier through the Charter verifier-registration proposal.
8. Register the CapacityRelease verifier through Charter proposal type 14 (`ReleaseVerifierRegistration`).
9. Record proposal IDs, execution transactions, deployed addresses, runtime-code hashes, build-attestation hashes, and ceremony evidence URLs in the production release evidence bundle.

No bootstrap administrator should retain a bypass around Charter verifier governance after production initialization.

## CI validation

CI exercises the same source-to-R1CS recompilation and finalized-artifact verifier against the repository's **development-only** proving keys using `mode=ci-validation`. CI-validation may omit `--min-contributions` and intentionally defaults to 1 so the deterministic single-contribution development fixture remains usable. CI-validation evidence cannot be consumed by the production provenance-wrapper generator, and the production release policy continues to require `setup=production-ceremony`.

This separation is intentional: CI proves that the build and ceremony verification tooling works; consortium participants provide the independent entropy and production ceremony trust assumption.
