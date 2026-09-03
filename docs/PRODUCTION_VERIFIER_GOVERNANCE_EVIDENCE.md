# Production Verifier Governance Evidence

ThreadProof treats **verifier deployment/provenance** and **verifier authorization** as separate trust boundaries. A verifier can be correctly built, deployed, and registered in `CapacityVault` while still lacking evidence that the registration was approved through the intended consortium governance path.

The production release therefore requires a sanitized `threadproof-production-verifier-governance/v1` artifact in addition to deployment evidence.

## What this artifact proves

For both `capacitySpend` and `capacityRelease`, the artifact binds:

- the exact production release version and tested `develop` SHA;
- chain ID `2026` and the production genesis hash;
- the exact `CapacityVault` and `ThreadProofCharter` addresses from the release manifest;
- the verifier circuit version, deployed address, circuit artifact hash, and verification-key hash;
- a distinct Charter proposal ID and the expected proposal type;
- the exact Charter action hash;
- the proposal's snapshotted policy version, approvals, constituency masks, and timelock;
- successful execution transaction hash, block number/hash, block timestamp, and executor address.

Production policy requires at least four approvals, a timelock of at least 24 hours, and Auditor + Regulator in both the required and actual approval masks.

For the current Charter enum:

- `VerifierRegistration` = proposal type `8`;
- `ReleaseVerifierRegistration` = proposal type `14`.

The spend and release registrations must use distinct proposals and distinct execution transactions.

## Exact-byte release binding

Operators create the final sanitized artifact at:

```text
docs/releases/<releaseVersion>/verifier-governance-evidence.json
```

The release manifest records:

```json
{
  "evidence": {
    "verifierGovernanceEvidenceUrl": "https://durable-archive.example/...",
    "verifierGovernanceEvidenceSha256": "64-lower-or-upper-hex-characters"
  }
}
```

`verify-release-verifier-governance-evidence.mjs` hashes the exact committed bytes **before** parsing JSON and requires the digest to equal the manifest. It rejects path escape, symlinks, empty/oversized files, malformed JSON, unknown schema fields, placeholders, secret-bearing fields, credential-bearing URLs, and release/chain/contract/verifier mismatches. The archive URL is contextual evidence only; the verifier does not fetch arbitrary network content.

## Live on-chain verification

`pnpm --filter @threadproof/contracts verify:production-deployment` independently re-checks the governance path against the production RPC. For each verifier registration it:

1. re-reads the final `CapacityVault` provenance tuple;
2. reads the Charter proposal from `getProposal` and requires `getProposalState(...) == Executed`;
3. recomputes the canonical action hash using the Charter's own `hashVerifierRegistrationAction` or `hashReleaseVerifierRegistrationAction` function;
4. compares the on-chain proposal snapshot to the evidence threshold, masks, approvals, policy version, and timelock;
5. fetches the recorded execution receipt and canonical block;
6. requires the transaction to have succeeded and to target `ThreadProofCharter`;
7. requires the transaction sender, block number/hash, and block timestamp to match the artifact;
8. requires matching Charter `ProposalExecuted` and verifier-authorization logs;
9. requires the same transaction receipt to contain the corresponding `CapacityVault` immutable provenance-registration event with the manifest verifier address, circuit hash, VK hash, and runtime-code hash.

That last transaction-level binding matters: because verifier registration is immutable per circuit version, a successful Charter execution that emits the matching vault registration event proves that the canonical registration transition occurred through that Charter execution rather than merely existing in the vault mapping.

## What this does not prove

This evidence does **not** prove that real-world governance representatives were personally independent or honest, that organization administration was correct off-chain, or that the Groth16 ceremony itself was trustworthy. Those concerns remain separate operational and ceremony evidence boundaries.

A numeric role mask is evidence of the on-chain constituency state and approvals represented by the protocol. It is not a substitute for real-world due diligence.

## Operator flow

1. Complete the production verifier build and ceremony evidence.
2. Deploy the final verifier contracts.
3. Create and approve the spend/release verifier-registration proposals through `ThreadProofCharter`.
4. Wait for the snapshotted timelock and execute each proposal.
5. Record the resulting non-secret proposal/receipt/block identifiers in a copy of `release/production-verifier-governance-evidence.example.json`.
6. Keep the example's `REPLACE_ME` placeholders out of final evidence.
7. Run:

```bash
node scripts/test-production-verifier-governance-evidence.mjs
node scripts/test-production-verifier-governance-template.mjs
node scripts/production-verifier-governance-evidence.mjs docs/releases/v1.0.0/verifier-governance-evidence.json
```

8. Hash the exact committed artifact bytes and place that SHA-256 plus the durable HTTPS archive reference in `release/production-release.json`.
9. Run the release-bound verifier and the live production RPC verifier before promotion.

Do not include private keys, signing material, KMS/HSM credentials, passwords, access tokens, private supplier data, ZK witnesses, or decrypted private capacity state in this artifact.
