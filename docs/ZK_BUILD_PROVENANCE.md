# ThreadProof ZK Build Provenance Boundaries

Production Groth16 evidence must bind the verifier artifacts to reproducible circuit inputs without overstating what the build tooling proves. ThreadProof separates three reproducibility boundaries that must all remain explicit.

## 1. Tracked source cleanliness

`verify-circuit-build.mjs` requires the named `--source-commit` to equal the actual Git `HEAD`, requires a non-zero exact 40-hex SHA, records `HEAD^{tree}`, and rejects a dirty tracked working tree. The root workspace manifest, circuit package manifest, workspace manifest, lockfile, circuit source, and recursive include closure are hashed into the build attestation.

This proves which tracked source revision was used. It does not make untracked package installations trustworthy by itself.

## 2. Dependency reproducibility

The attested compiler no longer resolves Circom includes from repository `node_modules`.

For every build verification, ThreadProof creates a disposable workspace containing only the frozen tracked package/workspace manifests and `pnpm-lock.yaml`, resolves the pinned pnpm 10.15.0 executable, and runs:

```text
pnpm install --offline --frozen-lockfile --ignore-scripts --prod --filter @threadproof/circuits...
```

Compilation and recursive Circom include hashing then use only `packages/circuits/node_modules` inside that disposable workspace. The attestation records:

- exact pnpm version and executable SHA-256,
- `pnpm-offline-frozen-lockfile` as the dependency-install method,
- production-only dependency installation,
- install scripts disabled,
- repository `node_modules` not used,
- the exact recursive Circom dependency closure actually read by the compiler.

The command fails closed when the required packages cannot be reconstructed from the already-populated pnpm store. It therefore avoids silently fetching different package bytes during production provenance verification.

`test-dependency-rehydration.mjs` provides the negative regression test. After the canonical CapacitySpend R1CS has been compiled, the test replaces the repository-local `circomlib` entry with a private tampered copy and changes `circuits/poseidon.circom`. Build verification must still reproduce the canonical R1CS using the isolated frozen-lockfile dependency tree, and the attested Poseidon hash must differ from the tampered local hash. The original local dependency entry is restored in a `finally` block.

This boundary proves that mutable repository `node_modules` cannot silently define production circuit provenance. It still depends on the integrity of the controlled pnpm content-addressed store used by the offline installation; production operators should preserve/cache that store or an equivalent reproducible dependency bundle as release evidence.

## 3. Compiler reproducibility

ThreadProof requires Circom 2.2.0 built from pinned source revision:

```text
9fd40a34f42912ee52230f8b6a114d78f6df1a48
```

The actual Circom executable used for recompilation is hashed into the build attestation. A version mismatch fails closed.

This records and binds the exact compiler binary that produced the verified R1CS. It is not a proof that another operator can independently reproduce the same compiler binary bit-for-bit from the pinned Rust source/toolchain. A production release should therefore archive the compiler binary digest and its build environment, and may add reproducible compiler-build attestations later.

## Source-to-verifier chain

The intended production evidence chain is:

```text
exact Git source/tree
  -> offline frozen-lockfile dependency rehydration
  -> pinned + hashed Circom compiler
  -> byte-identical rebuilt R1CS
  -> build-attestation SHA-256
  -> verified Powers-of-Tau + final zkey
  -> >= 2 verified Phase-2 contributions
  -> ceremony-evidence SHA-256
  -> verification-key / Solidity-verifier hashes
  -> provenance-bound verifier wrapper
  -> deployed runtime/code-hash verification
  -> Charter-approved verifier registration
```

`verify-production-ceremony.mjs` rejects build attestations that do not prove frozen-lockfile dependency rehydration or that claim repository `node_modules` was used. `generate-production-verifier-wrapper.mjs` repeats those checks and also refuses production evidence below the two-contribution policy floor.

## What this does not prove

These controls establish software/artifact provenance. They do not:

- perform the MPC ceremony or create participant entropy,
- prove ceremony contributors were independently administered or honest,
- prove the compiler executable is reproducibly buildable bit-for-bit,
- prove physical factory/audit inputs are truthful,
- replace ThreadProof's Oracle Boundary, Charter governance, or on-chain authorization checks.

The application, database, AI services, release metadata, and dashboards remain non-authoritative. Production authorization still derives from signed/on-chain state and deterministic ZK/governance validation.
