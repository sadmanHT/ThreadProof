# ThreadProof ZK Release Artifacts

ThreadProof treats Groth16 setup/proving outputs as release artifacts, not ordinary source files.

The repository **does version** the inputs, policies, proof vectors, generation/verification code, and exact cryptographic hashes that define a release. Large `.r1cs`, `.wasm`, `.zkey`, Powers of Tau, verification-key, proof, and generated-verifier outputs are produced from an exact clean Git SHA and published together as an immutable workflow/release artifact.

## Why the binaries are not committed directly

Large proving binaries create noisy Git history and make accidental reuse of a development ceremony easier. ThreadProof instead requires a release package whose manifest binds every artifact to:

- the exact 40-hex source commit and Git tree;
- the exact Circom circuit source and frozen dependency closure;
- the compiled R1CS and WASM hashes;
- the finalized zkey and Powers of Tau hashes;
- the verification key and generated Solidity verifier hashes;
- the build attestation and Groth16 ceremony evidence;
- the versioned positive/negative proof-vector source and executed vector-result manifest;
- the ZK benchmark measurements produced by the same build.

The package generator is:

```bash
pnpm --filter @threadproof/circuits package:zk
```

For CI this packages the deterministic **development-only** Groth16 ceremony created by the smoke test. It must never be represented as production setup.

For production, set `THREADPROOF_ZK_PACKAGE_MODE=production` and provide the finalized production artifact paths through the documented `THREADPROOF_ZK_*` path overrides. Production packaging fails closed unless the ceremony evidence itself is `mode=production` and is bound to the exact current source commit.

## Versioned proof vectors

`packages/circuits/vectors/CapacitySpend.v1.json` is the canonical versioned CapacitySpend vector suite.

The witness harness derives Poseidon commitments from those exact decimal inputs and circuit domain tags, executes every positive/negative vector, and writes:

`packages/circuits/artifacts/witness-tests/vector-results.json`

The ZK package generator requires the result manifest to hash-match the versioned vector source.

## Required release bundle

A CapacitySpend release bundle must contain the files hashed by:

`packages/circuits/artifacts/reproducibility/CapacitySpend_manifest.json`

The manifest itself is accompanied by a SHA-256 checksum. A release is incomplete if any listed artifact is absent, hash-mismatched, sourced from a different commit, or backed by the wrong ceremony mode.

## Security boundary

Never publish participant entropy, validator private keys, application signing keys, or confidential factory openings in the ZK release bundle. The proving key and Powers of Tau are public proving-system artifacts; secrets used to create them are not.
