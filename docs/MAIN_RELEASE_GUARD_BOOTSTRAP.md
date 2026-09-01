# ThreadProof main release-guard bootstrap

`main` currently predates ThreadProof's production release workflow. A `pull_request` workflow proposed by the same release candidate cannot be treated as an independent release gate because the candidate can modify the workflow and helper code that evaluates it.

This bootstrap installs a target-side `pull_request_target` guard on `main` before any production source promotion. It is intentionally separate from the application release.

## One-time bootstrap review

The bootstrap PR itself is **not** protected by the guard it installs. Before merging it, an administrator must manually review the exact diff and confirm that it only introduces:

- `.github/workflows/release-candidate-guard.yml`
- `scripts/trusted-main-release-guard.mjs`
- `scripts/trusted-main-target-history-guard.mjs`
- `scripts/trusted-main-build-evidence-guard.mjs`
- this bootstrap note

Do not combine application, contract, circuit, dependency, infrastructure, or release-manifest changes into the bootstrap PR.

After merge, configure `main` branch protection or a repository ruleset so the `ThreadProof Trusted Main Release Guard / trusted-main-release-guard` check is required for production release PRs. The guard is defense in depth until that external platform control is enabled.

## Trust boundary

The installed workflow uses `pull_request_target`, but it does **not** check out or execute the candidate branch. It checks out exactly the target `main` base SHA, uses read-only `actions`, `contents`, and `pull-requests` permissions, and reads candidate metadata/content only through GitHub's API.

The guard requires a production release PR to:

- originate from `sadmanHT/ThreadProof`, not a fork;
- use a `release/` branch and target `main`;
- provide a valid `release/production-release.json` at the exact PR head SHA;
- name a non-zero canonical `develop` source SHA;
- prove that source is an ancestor of current `develop` and of the release head;
- contain no untested post-source delta except `release/production-release.json`, `CHANGELOG.md`, and files under `docs/releases/`;
- prove that target-only `main` history contains no application, contract, circuit, dependency, or infrastructure delta outside the trusted guard files and prior release metadata;
- require non-zero circuit-build attestation SHA-256 commitments for both production verifier entries;
- bind clean-state and QBFT evidence URLs to successful canonical GitHub Actions runs;
- have all nine required ThreadProof workflows completed successfully as `push` runs on `develop` for exactly the manifest source SHA;
- retain production ceremony, remote Web3Signer/KMS-HSM, external-control, and release-approval attestations required by the manifest schema.

The guard re-reads the current `main` tip before succeeding so a moved target requires a fresh run. The candidate guard also re-reads the PR head/base before success.

## Why target-only history is checked

A tested `develop` source and `main` can be intentionally diverged. Without a target-history check, application code committed only to `main` could enter the final merge even though it never passed the exact-source ThreadProof matrix. The target-history guard resolves the common merge base and permits only the trusted main release-guard files plus prior release metadata (`release/production-release.json`, `CHANGELOG.md`, and `docs/releases/*`). Any other target-only path fails closed.

## Why build evidence is checked on trusted main

The release branch is allowed to add only release metadata after the tested `develop` source. Because production build-attestation digests are security-critical release metadata, the target-side guard independently requires both verifier entries to carry a non-zero `buildAttestationSha256`. This check executes trusted code from `main`; a candidate cannot remove the requirement by editing a workflow in its own branch.

The deeper source-to-R1CS proof is created on tested `develop`: production ceremony verification recompiles the exact clean source SHA with the pinned Circom toolchain, hashes the recursive dependency closure, and requires the rebuilt R1CS hash to equal the supplied ceremony R1CS. The trusted `main` guard ensures the resulting attestation commitments remain present in the promoted release manifest.

## What this does not prove

This bootstrap does not make a release production-ready by itself. It does not perform the real Groth16 ceremony, provision independent QBFT validators, provide KMS/HSM custody, enable Supabase leaked-password protection, create branch protection, conduct consortium UAT, or attest physical supply-chain facts. Those remain separate production acceptance criteria.
