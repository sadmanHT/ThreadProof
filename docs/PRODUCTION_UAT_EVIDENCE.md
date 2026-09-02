# Production UAT and adversarial evidence

ThreadProof production promotion requires a sanitized, machine-verifiable UAT evidence bundle. This bundle is release evidence, not protocol state: it proves that a specific byte-for-byte record contains all required scenarios and is bound to the release source, chain, deployment and signing configuration. It does **not** independently prove that a physical-world event occurred, that an auditor's judgment was truthful, or that named consortium operators were honest.

## Release binding

For release version `vX.Y.Z`, place the sanitized evidence at exactly:

```text
docs/releases/vX.Y.Z/uat-adversarial-evidence.json
```

Compute the SHA-256 of those exact file bytes and set `release/production-release.json` field `evidence.uatAdversarialEvidenceSha256` to the lowercase 64-character digest. Set `evidence.uatAdversarialEvidenceUrl` to the HTTPS archive location for the same sanitized bytes. The production-readiness workflow reads the committed file locally, recomputes its digest, and rejects any mismatch.

Run the gate from the repository root:

```bash
node scripts/test-production-uat-evidence.mjs
node scripts/verify-release-uat-evidence.mjs
```

The second command requires the real `release/production-release.json` and therefore is expected to fail on ordinary `develop` checkouts where production release metadata has intentionally not been committed.

## Top-level evidence contract

The JSON object uses `format: "threadproof-production-uat/v1"` and `result: "pass"`. It must bind `releaseVersion`, `sourceDevelopCommit`, `chainId`, `genesisHash`, `validatorCount`, and `deploymentManifestSha256` to the production release manifest. `environment` must be `production`, `networkType` must be `persistent-consortium`, and `signing` must assert `mode: "remote-web3signer"` with `kmsOrHsmBacked: true`.

`startedAt` and `completedAt` delimit the UAT execution window. Every case must fall inside that window. UAT completion and auditor/regulator signoff must precede `release.preparedAt`.

Do not place worker PII, supplier names, email addresses, phone numbers, API keys, service-role keys, private keys, mnemonic material, passwords or other secrets in this file. The validator rejects obvious secret-bearing field names and placeholder text. Use opaque participant IDs plus consortium-visible organization IDs and wallet addresses.

## Distinct consortium identities

The bundle must contain at least six distinct participants: buyer, primary factory, subcontract factory, auditor, regulator, and worker/labor. Organization IDs and wallet addresses must be distinct. Cases reference exact `participantIds`, not only role labels. `subcontract_authorization` must include two separate factory participants, so the evidence cannot satisfy the subcontract requirement with one factory acting twice.

Auditor and regulator participant IDs must both appear in `signoff.reviewerParticipantIds`. `signoff.executedBy` is a non-secret operator identifier, not a person's full name or email address.

## Required functional cases

The exact functional set is: `onboarding`, `credential_issue`, `credential_revocation`, `capacity_certification`, `order_authorization`, `pofc_spend`, `subcontract_authorization`, `order_amendment`, `order_cancellation`, `capacity_release`, `due_process_disclosure`, `credential_package_export`, and `credential_package_verification`.

Each case records `result: "pass"`, participating IDs, expected/observed descriptions, start/completion timestamps, and a sanitized transcript URL plus SHA-256. Chain-success cases also include a canonical receipt with chain ID, transaction hash, block number, block hash, contract address and event name. The release verifier binds those receipt contract addresses to the deployed `Registry`, `CredentialRegistry`, `OrderRegistry`, `CapacityVault`, `SubcontractGovernor`, or `ThreadProofCharter` address appropriate to that case.

Due-Process Disclosure additionally commits the sealed `threadproof-protected-identity-disclosure/v1` package. Credential package export and verification commit `threadproof-credential-package/v1` package bytes. Package URLs point to sanitized/encrypted artifacts only; plaintext protected identity or private credential bodies must not be copied into UAT evidence.

## Required adversarial cases

The exact adversarial set is: `stale_capacity`, `duplicate_nullifier`, `invalid_proof`, `invalid_allocation`, `release_replay`, `revoked_credential`, `rpc_outage`, `signer_outage`, and `validator_loss`.

Rejected protocol requests must record an error code, request SHA-256, `canonicalStateUnchanged: true`, and matching before/after state hashes. RPC and signer outage cases must show the attempted operation was rejected, safety was preserved, the observation duration was non-zero, and canonical state did not change.

`validator_loss` must contain measured block observations rather than only booleans. With one validator unavailable, at least two additional finalized blocks must be observed. After quorum loss, the RPC endpoint must remain responsive while finalized height stays exactly unchanged for the observation window and a protected operation is rejected without canonical state change. After quorum restoration, at least two additional finalized blocks must be observed. This encodes the ThreadProof QBFT safety/liveness boundary without claiming that a five-validator pilot proves large-network Byzantine robustness.

## Transcript boundary

The top-level UAT file is intentionally sanitized and small. Each case may point to a larger immutable transcript, log bundle, transaction receipt archive, benchmark, sealed package, or operator record using an HTTPS URL plus SHA-256. The release gate validates those commitments but does not fetch every referenced transcript. Preserve the underlying artifacts in consortium-approved storage and apply the project's evidence-retention policy.

The UAT bundle is release evidence only. Blockchain state, signatures, ZK verification, credential status, and Charter governance remain authoritative for protocol transitions; application databases, dashboards, AI output, and this UAT JSON cannot override them.
