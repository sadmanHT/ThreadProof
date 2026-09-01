# ThreadProof main release-guard bootstrap

`main` currently predates ThreadProof's production release workflow. A `pull_request` workflow proposed by the same release candidate cannot be treated as an independent release gate because the candidate can modify the workflow and helper code that evaluates it.

This bootstrap installs a target-side `pull_request_target` guard on `main` before any production source promotion. It is intentionally separate from the application release.

## One-time bootstrap review

The bootstrap PR itself is **not** protected by the guard it installs. Before merging it, an administrator must manually review the exact diff and confirm that it only introduces:

- `.github/workflows/release-candidate-guard.yml`
- `scripts/trusted-main-release-guard.mjs`
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
- bind clean-state and QBFT evidence URLs to successful canonical GitHub Actions runs;
- have all nine required ThreadProof workflows completed successfully as `push` runs on `develop` for exactly the manifest source SHA;
- retain production ceremony, remote Web3Signer/KMS-HSM, external-control, and release-approval attestations required by the manifest schema.

The guard also re-reads the PR and current `main` tip before succeeding so a moved head or target requires a fresh run.

## What this does not prove

This bootstrap does not make a release production-ready by itself. It does not perform the real Groth16 ceremony, provision independent QBFT validators, provide KMS/HSM custody, enable Supabase leaked-password protection, create branch protection, conduct consortium UAT, or attest physical supply-chain facts. Those remain separate production acceptance criteria.
