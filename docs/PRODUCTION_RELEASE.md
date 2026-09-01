# ThreadProof Production Release Runbook

This runbook governs promotion from the fully tested `develop` branch to `main` and a persistent consortium deployment. It is intentionally fail-closed: development proof artifacts, disposable pilot identities, unprotected branches, local signers, placeholder manifests, or incomplete external security controls are not acceptable production evidence.

## 1. Freeze a tested develop source

1. Select the exact `develop` commit that has passed the complete ThreadProof matrix:
   - ThreadProof CI
   - ThreadProof Endgame Scorecard
   - ThreadProof Live Pilot
   - ThreadProof Live PoFC
   - ThreadProof Live Subcontract
   - ThreadProof Live Capacity Release
   - ThreadProof Clean-State Endgame
   - ThreadProof Release Policy
2. Record that 40-character SHA as `release.sourceDevelopCommit`.
3. Do not modify application, worker, contract, circuit, infrastructure, or migration code on the production-promotion branch. Any such change must return to `develop` and repeat the complete matrix.

The production-readiness workflow enforces that only `release/production-release.json`, `CHANGELOG.md`, and `docs/releases/*` may differ after the tested source commit.

## 2. Provision the persistent chain-2026 consortium

The disposable five-validator pilot is reproducibility evidence, not the production network.

For the persistent network:

- use chain ID `2026`;
- operate at least five independently administered QBFT validators;
- use approved genesis, validator identities, peer allowlists and network permissions;
- keep validator and transaction signing keys out of Git and application containers;
- use remote Web3Signer with KMS/HSM-backed custody;
- configure TLS/private networking, monitoring, persistent storage and backup/recovery;
- capture the final genesis hash and non-secret topology/deployment evidence.

Do not copy disposable pilot private keys into the persistent environment.

## 3. Perform the production Groth16 setup

CI-generated Groth16 setup material is explicitly development evidence.

Before a production release:

1. Freeze the exact CapacitySpend and CapacityRelease circuit sources and compiler version.
2. Run the consortium-approved production ceremony/setup process.
3. Archive the ceremony transcript/evidence in durable storage.
4. Record a SHA-256 digest and HTTPS evidence location for each ceremony package.
5. Compute the final circuit artifact hash and verification-key hash.
6. Deploy the final provenance-bound verifier contracts.
7. Register the spend and release verifiers through the ThreadProof Charter governance process. Release-verifier registration must use the dedicated Charter proposal type and its required threshold/timelock.

The production manifest requires `setup: "production-ceremony"` for both verifiers and rejects development setup labels.

## 4. Deploy and verify protocol contracts

Deploy the canonical production suite:

- Registry
- CredentialRegistry
- OrderRegistry
- CapacityVault
- SubcontractGovernor
- ThreadProofCharter

For every contract, record:

- deployed address;
- runtime bytecode hash;
- deployment transaction/evidence;
- role ownership and governance handoff.

Confirm the final contract code hashes directly against the chain before recording them in the release manifest.

## 5. Run production-environment acceptance tests

Execute the business and adversarial paths with separate consortium identities:

- organization onboarding and role checks;
- credential issuance, suspension and revocation;
- capacity certification;
- buyer-signed order authorization;
- PoFC spend;
- stale commitment and duplicate-nullifier rejection;
- PoFC-backed subcontract authorization and invalid subcontract rejection;
- order cancellation/amendment and cryptographic capacity release;
- replayed release rejection;
- threshold/timelocked protected-identity disclosure;
- private credential package seal/export/chain verification;
- worker restart/claim recovery;
- RPC outage, signer outage and validator-loss exercises;
- indexer canonical cursor/reorg quarantine behavior;
- Supabase read-model rebuild from canonical events.

Archive benchmark and deployment evidence and compute SHA-256 digests for the bundles.

## 6. Complete external platform controls

These controls are independent operator actions and must not be self-attested by application code:

- protect `develop` or apply an equivalent repository ruleset;
- protect `main` or apply an equivalent repository ruleset;
- block force-push/deletion for normal operation;
- require the ThreadProof CI/security/release checks before merge;
- enable Supabase Auth leaked-password protection;
- re-read GitHub protection/ruleset state and rerun Supabase security advisors.

Record the verifier/operator identity and timestamp in `externalControls` only after these checks are actually complete.

## 7. Prepare the release manifest

Copy `release/production-release.example.json` to `release/production-release.json` on a dedicated release branch created from the tested `develop` source.

Replace every placeholder with verified, non-secret production evidence. The manifest contains only public deployment identifiers, hashes, URLs and attestations; never place private keys, KMS credentials, passwords, decrypted supplier identities, ZK witnesses or Supabase service keys in it.

Validate the release policy locally:

```bash
node scripts/test-release-readiness.mjs
node scripts/check-release-readiness.mjs
```

Then verify the manifest against the actual persistent chain. The verifier reads only the RPC and does not require or print a signer private key:

```bash
THREADPROOF_RPC_URL="https://your-approved-production-rpc" \
THREADPROOF_CHAIN_ID=2026 \
pnpm --filter @threadproof/contracts verify:production-deployment
```

That command checks the live RPC chain ID and genesis hash, recomputes runtime bytecode hashes for every manifest contract and both ZK verifiers, and compares the CapacityVault spend/release verifier provenance records to the manifest's circuit artifact, verification-key and code hashes. A mismatch fails closed.

The manifest checker requires:

- semantic release version;
- full tested `develop` SHA;
- chain ID 2026 and non-zero genesis hash;
- at least five validators;
- all six required protocol contracts with distinct addresses and runtime code hashes;
- production-ceremony evidence for both ZK verifiers;
- remote Web3Signer plus KMS/HSM-backed custody;
- clean-state, benchmark and deployment evidence;
- verified branch protection for `develop` and `main`;
- verified Supabase leaked-password protection;
- explicit production-release approval.

## 8. Promote to main

Open a pull request to `main` from the dedicated release branch. The `ThreadProof Production Readiness` workflow will:

1. validate the manifest;
2. rerun production trust-boundary and endgame scorecard checks;
3. verify the recorded source commit is an ancestor of both the release branch and `origin/develop`;
4. reject any application/code/config change made after the tested source commit.

Only merge after every required check is green and the PR still points to the reviewed release head.

## 9. Tag and archive

After main promotion:

- create the release tag/version;
- publish the final manifest and release notes;
- retain ceremony, benchmark, clean-state and deployment evidence in durable storage;
- record genesis and contract/verifier hashes in consortium operations documentation;
- verify workers and indexer are reporting healthy runtime state;
- verify the web application reports the expected chain ID, bytecode and canonical transaction state.

## 10. Recovery principle

Production recovery must preserve ThreadProof's trust model. If private capacity opening material is lost, do not administratively invent a new opening. Freeze that capacity key and use the approved protected recovery/recertification process. If canonical chain and Supabase disagree, rebuild the read model from confirmed canonical events rather than overwriting chain truth.
