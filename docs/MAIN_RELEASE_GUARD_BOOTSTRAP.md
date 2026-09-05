# ThreadProof main release-guard bootstrap

`main` predates ThreadProof's production release workflow. A `pull_request` workflow proposed by the same release candidate cannot be treated as an independent release gate because the candidate can modify the workflow and helper code that evaluates it.

The bootstrap installs a target-side `pull_request_target` guard on `main` before any production source promotion. It is intentionally separate from the application release.

## One-time bootstrap review

The original bootstrap PR was **not** protected by the guard it installed. Before merging it, an administrator manually reviewed the exact diff and confirmed that it only introduced:

- `.github/workflows/release-candidate-guard.yml`
- `scripts/trusted-main-release-guard.mjs`
- `scripts/trusted-main-target-history-guard.mjs`
- `scripts/trusted-main-build-evidence-guard.mjs`
- this bootstrap note

No application, contract, circuit, dependency, infrastructure, or release-manifest change belonged in that bootstrap PR.

## Trusted-guard maintenance bootstrap

The first installed guard intentionally made production promotion strict, but that creates a control-plane maintenance problem: once `main` protection requires the trusted check, the trusted workflow and guard files must still have a narrowly governed way to evolve. Issue #52 introduces that path before final branch protection is enabled.

The maintenance path has its own branch namespace:

`security/trusted-main-guard/*`

It is distinct from production `release/*` branches. A future maintenance PR is accepted by the trusted base-side guard only when all of the following hold:

- the PR targets `main` and originates from the canonical `sadmanHT/ThreadProof` repository;
- the branch uses the exact `security/trusted-main-guard/` prefix;
- changed paths are limited to the audited trusted-main workflow/scripts and this document;
- at least one trusted policy/workflow file changes, so the maintenance path cannot be used as a generic documentation bypass;
- no trusted policy file is deleted;
- the PR body contains a non-placeholder `Trusted-Main-Change-Reference: ...` line;
- an administrator/maintainer manually applies the `trusted-main-reviewed` label after reviewing the exact diff;
- the candidate trusted workflow bytes hash to a SHA-256 value that the **already trusted base-side maintenance guard** explicitly allowlists;
- the workflow retains `pull_request_target`, read-only `actions`/`contents`/`pull-requests` permissions, exact base-SHA checkout with credentials disabled, pinned checkout/setup-node actions, and the single trusted guard job;
- obvious privilege/candidate-execution surfaces such as write permissions, secret references, head-SHA/head-ref checkout, containers, services, or candidate working directories remain forbidden;
- the reviewed PR head/base and current `main` tip have not moved while the trusted check runs.

The maintenance verifier reads candidate files only through the GitHub API. It does **not** execute candidate JavaScript or candidate workflow code. The `trusted-main-reviewed` label is an explicit manual review signal, not a claim of independent multi-person approval. If the repository later has multiple administrators, branch/ruleset policy should require an independent approving reviewer or CODEOWNER in addition to this label.

### Why the workflow is byte-pinned

A substring check such as “the workflow still contains `persist-credentials: false`” is not a sufficient self-maintenance boundary. A candidate could retain the safe marker while adding another checkout, another action, another job, or an inline command that executes candidate-controlled material.

The maintenance guard therefore SHA-256 pins the complete trusted workflow bytes. The current approved workflow hash is recorded inside the already trusted `scripts/trusted-main-maintenance-guard.mjs`. A candidate that changes the workflow to any unapproved byte sequence fails before that candidate code can become trusted.

This deliberately creates a **two-stage process** for any future change that expands or alters the workflow executable surface:

1. First open a reviewed maintenance PR that changes only the base-side maintenance policy (and documentation if needed) to pre-approve the exact SHA-256 of the intended future workflow. The workflow itself remains unchanged, so the old trusted guard can validate the PR.
2. After that policy change is merged and becomes trusted `main`, open a second reviewed maintenance PR containing the exact pre-approved workflow bytes. The new base-side guard verifies their SHA-256 before the workflow can be merged.

This two-stage process prevents a single maintenance candidate from both redefining what workflow is trusted and installing arbitrary new executable workflow content in the same already-protected step. Emergency direct edits are not a substitute for this process.

### Maintenance bootstrap limitation

The PR that first adds `scripts/trusted-main-maintenance-guard.mjs` cannot be validated by that script through `pull_request_target`, because the trusted base SHA does not contain the new maintenance verifier yet. This is a one-time bootstrap limitation analogous to the original trusted-main guard installation.

Before merging that first maintenance-path PR, manually verify that its diff is restricted to:

- `.github/workflows/release-candidate-guard.yml`
- `scripts/trusted-main-maintenance-guard.mjs`
- `docs/MAIN_RELEASE_GUARD_BOOTSTRAP.md`

and confirm that the workflow preserves read-only permissions, target/base checkout, `persist-credentials: false`, pinned actions, and the unchanged production `release/*` path. Also independently recompute the workflow SHA-256 and confirm it equals the initial allowlisted digest in the maintenance guard. Do not enable final `main` protection until this bootstrap has been reviewed and merged.

Before enabling final protection, create the repository label `trusted-main-reviewed` and restrict label/application permissions to maintainers who are authorized to review trusted-main changes. The label is a review signal, not a cryptographic or multi-party approval mechanism.

## Production release path

Production promotion remains separate and unchanged. A production release PR must:

- originate from `sadmanHT/ThreadProof`, not a fork;
- use a `release/` branch and target `main`;
- provide a valid `release/production-release.json` at the exact PR head SHA;
- name a non-zero canonical `develop` source SHA;
- use a source that descends from or equals the trusted release-security floor `8575371a84f6395a610d158fd498f4790f285a64`, so production promotion cannot intentionally downgrade to a certified source from before PR #80 exact-byte production ceremony-evidence binding and the preceding verifier-governance/release-evidence hardening;
- contain the trusted `.github/workflows/production-readiness.yml` bytes at the selected source commit. The currently approved Git blob is `c12ffa13a6956d5e96c25343aac3cc6840ef207a`; changing those workflow bytes requires a separate trusted-main maintenance review before that newer source can be promoted;
- prove that source is an ancestor of current `develop` and of the release head;
- contain no untested post-source delta except `release/production-release.json`, `CHANGELOG.md`, and files under `docs/releases/`;
- prove that target-only `main` history contains no application, contract, circuit, dependency, or infrastructure delta outside the trusted guard files and prior release metadata;
- require non-zero circuit-build attestation SHA-256 commitments for both production verifier entries;
- bind clean-state and QBFT evidence URLs to successful canonical GitHub Actions runs;
- have all nine required ThreadProof workflows completed successfully as `push` runs on `develop` for exactly the manifest source SHA;
- have `ThreadProof Production Readiness` completed successfully as a `pull_request` run for the exact release PR head SHA, the same PR number, and the same `main` base SHA observed by the target-side guard;
- retain production ceremony, verifier-governance, remote Web3Signer/KMS-HSM, external-control, UAT/recovery, and release-approval attestations required by the manifest schema.

The guard re-reads the current `main` tip and release PR metadata before and after remote Actions evidence verification so a moved target or head fails closed. Branch protection's up-to-date/merge-queue requirement closes the later race in which `main` could advance after a successful guard run but before merge.

## Final branch/ruleset policy

After the maintenance bootstrap is merged, configure `main` branch protection or a repository ruleset so the `ThreadProof Trusted Main Release Guard / trusted-main-release-guard` check is required. Also require the PR branch to be up to date with current `main` before merge, or use an equivalent merge-queue/ruleset guarantee. Block normal direct pushes, force-pushes, and branch deletion.

The platform policy should treat `release/*` and `security/trusted-main-guard/*` as the only intended main-targeting branch classes. Production release PRs must not use the maintenance review label as a bypass, and maintenance PRs must not contain release/application source. The trusted base-side job enforces these classes independently of candidate code.

## Trust boundary

The installed workflow uses `pull_request_target`, but it does **not** check out or execute the candidate branch. It checks out exactly the target `main` base SHA, uses read-only `actions`, `contents`, and `pull-requests` permissions, and reads candidate metadata/content only through GitHub's API.

### Why target-only history is checked

A tested `develop` source and `main` can be intentionally diverged. Without a target-history check, application code committed only to `main` could enter the final merge even though it never passed the exact-source ThreadProof matrix. The target-history guard resolves the common merge base and permits only the trusted main release-guard files plus prior release metadata (`release/production-release.json`, `CHANGELOG.md`, and `docs/releases/*`). Any other target-only path fails closed.

### Why build evidence is checked on trusted main

The release branch is allowed to add only release metadata after the tested `develop` source. Because production build-attestation digests are security-critical release metadata, the target-side guard independently requires both verifier entries to carry a non-zero `buildAttestationSha256`. This check executes trusted code from `main`; a candidate cannot remove the requirement by editing a workflow in its own branch.

The deeper source-to-R1CS proof is created on tested `develop`: production ceremony verification recompiles the exact clean source SHA with the pinned Circom toolchain, hashes the dependency closure rehydrated from the frozen lockfile, and requires the rebuilt R1CS hash to equal the supplied ceremony R1CS. The trusted `main` guard ensures the resulting attestation commitments remain present in the promoted release manifest.

### Why exact-head Production Readiness can be required safely

`ThreadProof Production Readiness` is a normal `pull_request` workflow, so its candidate-side execution is not independently trusted by itself. The target-side guard first proves two facts using code already trusted on `main`: the selected source cannot predate the trusted security floor, and the source commit contains the exact approved Production Readiness workflow blob. It then proves the release head contains no workflow/script/config change after that selected source except the narrow release metadata allowlist.

Only after those checks does the target-side guard accept a successful Production Readiness run, and it requires that run to be for the exact release head, release branch, PR number, and current `main` base. That run performs the deeper release-manifest, exact-byte production ceremony-evidence, deployment, verifier-governance, UAT/adversarial, backup/recovery, platform-controls and canonical-GitHub evidence verification. The privileged `pull_request_target` job still never checks out or executes candidate code.

If `.github/workflows/production-readiness.yml` changes on a future `develop` source, production release promotion intentionally fails until a separate `security/trusted-main-guard/*` maintenance PR reviews and updates the approved workflow blob. This prevents a later source from weakening its own readiness workflow and immediately using that weaker run as trusted promotion evidence.

## What this does not prove

The trusted-main guard and its maintenance path protect release/control-plane provenance. They do not make a release production-ready by themselves. They do not perform the real Groth16 ceremony, provision independent QBFT validators, provide KMS/HSM custody, enable Supabase leaked-password protection, create real production UAT evidence, or attest physical supply-chain facts. Those remain separate production acceptance criteria.
