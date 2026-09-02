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
   - ThreadProof QBFT Fault Resilience
2. Record that 40-character SHA as `release.sourceDevelopCommit`.
3. Do not modify application, worker, contract, circuit, infrastructure, or migration code on the production-promotion branch. Any such change must return to `develop` and repeat the complete matrix.

The production release guards enforce that only `release/production-release.json`, `CHANGELOG.md`, and `docs/releases/*` may differ after the tested source commit. The trusted target-side `main` guard also rejects untested application/config/circuit history that exists only on `main`.

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

1. Freeze the exact CapacitySpend and CapacityRelease source SHA, lockfile and pinned Circom 2.2.0 compiler revision.
2. Install dependencies from the frozen lockfile and use Circom revision `9fd40a34f42912ee52230f8b6a114d78f6df1a48`.
3. From a clean checkout of exactly `release.sourceDevelopCommit`, run the circuit build verifier for each R1CS. It must recursively hash the Circom include closure and byte-hash match the supplied R1CS against a fresh recompilation.
4. Archive each `<Circuit>_build_attestation.json` and checksum. Independently reproduce or review the recorded Git tree, compiler binary hash, source/include hashes, lockfile hash and R1CS hash.
5. Run the consortium-approved production ceremony/setup process using the build-verified R1CS for each circuit.
6. Verify the finalized Powers-of-Tau and zkey using `verify-production-ceremony.mjs`. Ceremony evidence must cryptographically include the corresponding build-attestation SHA-256.
7. Archive the ceremony transcript/evidence and SHA-256 digest in durable storage.
8. Generate production verifier wrappers. They must expose `circuitArtifactHash`, `verificationKeyHash`, `buildAttestationSha256`, and `ceremonyEvidenceSha256` as immutable public constants.
9. Deploy the final provenance-bound verifier contracts.
10. Register the spend and release verifiers through the ThreadProof Charter governance process. Release-verifier registration must use the dedicated Charter proposal type and its required threshold/timelock.

The production manifest requires `setup: "production-ceremony"` and a non-zero `buildAttestationSha256` for both verifiers. Legacy production evidence that only labels a source commit without proving a clean source-to-R1CS recompilation is rejected.

See `docs/PRODUCTION_ZK_CEREMONY.md` for the exact artifact and command flow.

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

Confirm the final contract code hashes directly against the chain before recording them in the release manifest. For each production ZK verifier, also read the deployed `buildAttestationSha256()` and `ceremonyEvidenceSha256()` constants and require them to equal the release manifest.

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
- require `ThreadProof Trusted Main Release Guard / trusted-main-release-guard` for production release PRs after its one-time bootstrap has been manually reviewed and installed;
- enable Supabase Auth leaked-password protection;
- re-read GitHub protection/ruleset state and rerun Supabase security advisors.

Record the verifier/operator identity and timestamp in `externalControls` only after these checks are actually complete. The final manifest enforces the lifecycle `externalControls.verifiedAt <= release.preparedAt <= approval.approvedAt`; do not backdate or reorder those attestations.

## 7. Prepare the release manifest

Copy `release/production-release.example.json` to `release/production-release.json` on a dedicated `release/*` branch created from the tested `develop` source.

Replace every placeholder with verified, non-secret production evidence. The manifest contains only public deployment identifiers, hashes, URLs and attestations; never place private keys, KMS credentials, passwords, decrypted supplier identities, ZK witnesses or Supabase service keys in it.

For both `verifiers.capacitySpend` and `verifiers.capacityRelease`, record the exact production `buildAttestationSha256` emitted by the clean-source build verification and exposed by the deployed verifier wrapper.

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

That command checks the live RPC chain ID and genesis hash, recomputes runtime bytecode hashes for every manifest contract and both ZK verifiers, compares the CapacityVault spend/release verifier provenance records to the manifest's circuit artifact, verification-key and code hashes, and verifies each verifier's deployed build-attestation and ceremony-evidence constants. A mismatch fails closed.

The manifest checker requires:

- a closed schema at the top level and within every security-relevant section; unknown or shadow fields are rejected;
- no secret-bearing field names or credential-bearing URLs anywhere in the manifest;
- semantic release version;
- full tested `develop` SHA;
- chain ID 2026 and non-zero genesis hash;
- at least five validators;
- exactly the six required protocol contracts, with no extra contracts, distinct addresses and runtime code hashes;
- both production verifier addresses distinct from each other and from every state-contract address;
- production-ceremony evidence for both ZK verifiers;
- non-zero circuit build-attestation SHA-256 commitments for both ZK verifiers;
- remote Web3Signer plus KMS/HSM-backed custody;
- clean-state, QBFT fault, benchmark and deployment evidence;
- verified branch protection for `develop` and `main`;
- verified Supabase leaked-password protection;
- chronology `externalControls.verifiedAt <= release.preparedAt <= approval.approvedAt`;
- explicit production-release approval.

## 8. Promote to main

Open a pull request to `main` from the dedicated `release/*` branch. Production promotion is guarded in two layers:

1. The tested `develop` production-readiness workflow validates manifest structure, canonical evidence and release-only delta.
2. The trusted `pull_request_target` guard already installed on `main` executes only target-side policy code, never candidate code. It re-resolves all nine canonical successful `develop` push workflows for exactly `release.sourceDevelopCommit`, checks clean-state/QBFT run bindings, requires build-attestation commitments, rejects forks and moved heads, and rejects untested candidate or target-only application/config/circuit changes.

Only merge after every required check is green, branch protection/rulesets actually require the trusted guard, and the PR still points to the reviewed release head.

## 9. Tag and archive

After main promotion:

- create the release tag/version;
- publish the final manifest and release notes;
- retain circuit build attestations, ceremony evidence, benchmark, clean-state, QBFT fault and deployment evidence in durable storage;
- record genesis and contract/verifier hashes in consortium operations documentation;
- verify workers and indexer are reporting healthy runtime state;
- verify the web application reports the expected chain ID, bytecode and canonical transaction state.

## 10. Recovery principle

Production recovery must preserve ThreadProof's trust model. If private capacity opening material is lost, do not administratively invent a new opening. Freeze that capacity key and use the approved protected recovery/recertification process. If canonical chain and Supabase disagree, rebuild the read model from confirmed canonical events rather than overwriting chain truth.
