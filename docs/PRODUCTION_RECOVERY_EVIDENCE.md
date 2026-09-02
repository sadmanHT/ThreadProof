# ThreadProof Production Recovery Evidence

This procedure creates the hash-bound recovery artifact required by the production release manifest fields `evidence.backupRecoveryEvidenceUrl` and `evidence.backupRecoveryEvidenceSha256`.

It is deliberately narrower than a generic database-restore claim. ThreadProof has two different recovery classes:

1. **Chain-derived projections** can be checked against canonical blockchain events. The current verifier reconstructs `governance_proposal_read_model` and `verifier_provenance_read_model` using the same stable event fields used by their database projection functions.
2. **Private encrypted material** cannot be reconstructed from the shared chain. Capacity openings, encrypted credential packages, protected identity material, and other private payloads must be restored from organization-controlled encrypted backups or follow the governed recertification/recovery path.

A passing artifact therefore proves projection consistency plus encrypted-backup byte integrity. It does **not** prove that lost private witnesses can be derived from blockchain history, and it does not make the application database authoritative for protocol writes.

## Inputs

Run the verifier only after a recovery rehearsal has restored the database and private backup material into an isolated environment.

The verifier requires:

- `--events`: a JSON array or JSONL export of chain `2026` canonical events. For production evidence, derive this independently by re-indexing the canonical RPC or from an independently archived canonical event export; do not use an unverified damaged read model as its own source of truth.
- `--restored-read-model`: a JSON object exported from the **restored** database containing `governanceProposals` and `verifierProvenance` arrays.
- `--backup-dir`: the encrypted source backup tree used for the rehearsal.
- `--restored-private-dir`: the recovered private tree after restore.
- `--source-commit`: the exact non-zero 40-character `develop` SHA being promoted.
- `--chain-id`: `2026` for the current production consortium.
- `--output`: destination for the sanitized evidence JSON.

The backup directories must contain at least one regular encrypted artifact. Symbolic links and other special filesystem entries fail closed. The source and restored directory trees must have identical relative paths, byte lengths, and file SHA-256 digests.

## Restored read-model export

The verifier accepts the database column names directly. A restored snapshot has this shape:

```json
{
  "format": "threadproof-restored-read-model/v1",
  "governanceProposals": [],
  "verifierProvenance": []
}
```

One PostgreSQL export pattern is:

```bash
psql "$RECOVERY_DATABASE_URL" -Atc "
select jsonb_build_object(
  'format', 'threadproof-restored-read-model/v1',
  'governanceProposals', coalesce(
    (select jsonb_agg(to_jsonb(g) order by g.chain_proposal_id)
       from public.governance_proposal_read_model g),
    '[]'::jsonb
  ),
  'verifierProvenance', coalesce(
    (select jsonb_agg(to_jsonb(v) order by v.chain_id, v.circuit_version)
       from public.verifier_provenance_read_model v),
    '[]'::jsonb
  )
);" > restored-read-model.json
```

`updated_at`, `observed_at`, `cancelled_at`, and `executed_at` may be present in the export, but the semantic comparison intentionally excludes observation-time metadata that is not part of canonical authorization state. Canonical event fields such as approval thresholds, action hashes, policy version, execute-after time, verifier hashes, transaction hashes, and synced block numbers are compared.

## Canonical event export

The event archive must preserve at least these columns:

- `chain_id`
- `block_number`
- `block_hash`
- `transaction_hash`
- `log_index`
- `contract_address`
- `event_name`
- `data`

For example, after re-indexing from the canonical chain into an isolated evidence database:

```bash
psql "$CANONICAL_REINDEX_DATABASE_URL" -Atc "
select coalesce(jsonb_agg(to_jsonb(e) order by e.block_number, e.log_index), '[]'::jsonb)
from (
  select
    chain_id,
    block_number,
    block_hash,
    transaction_hash,
    log_index,
    contract_address,
    event_name,
    data,
    observed_at
  from public.chain_events
  where chain_id = 2026
) e;" > canonical-chain-events.json
```

The verifier rejects mixed chain IDs, malformed hashes/addresses, duplicate `(chain_id, transaction_hash, log_index)` identities, governance events that cannot be replayed from a preceding `ProposalCreated`, and conflicting verifier provenance for one circuit version.

## Run the rehearsal verifier

```bash
pnpm recovery:verify -- \
  --events ./canonical-chain-events.json \
  --restored-read-model ./restored-read-model.json \
  --backup-dir /secure/rehearsal/source-backup \
  --restored-private-dir /secure/rehearsal/restored-private \
  --source-commit "$TESTED_DEVELOP_SHA" \
  --chain-id 2026 \
  --output ./artifacts/production-recovery-evidence.json
```

A successful run creates:

- `production-recovery-evidence.json`
- `production-recovery-evidence.json.sha256`

Both files are written mode `0600` by the Node verifier. Archive the evidence JSON in the release evidence store over HTTPS and copy the plain 64-hex digest from the `.sha256` file into `evidence.backupRecoveryEvidenceSha256`.

The evidence JSON contains only:

- exact source commit and chain ID;
- raw SHA-256 digests of the canonical event archive and restored read-model export;
- counts of replayed events/rows;
- a semantic projection digest;
- aggregate private-backup file count/byte count;
- source/restored private-tree root digests;
- pass/fail assertions and explicit limitations.

It does **not** contain private backup file paths, ciphertext bytes, remaining capacity, randomness, order terms, credential bodies, protected supplier identities, validator keys, or decrypted material.

## Regression test

The repository test is:

```bash
pnpm recovery:test
```

It covers the success path and fail-closed cases for governance drift, verifier-provenance drift, private backup tampering, incomplete event history, duplicate event identity, invalid source provenance, symbolic-link traversal, empty backup evidence, and accidental leakage of private backup contents or filenames into the artifact.

CI runs this regression in the `security` job. CI proves verifier behavior only; it does **not** substitute for the real production recovery rehearsal or create production evidence from fixtures.

## Recovery boundary

A successful artifact supports the following bounded statement:

> The restored chain-derived governance/verifier projections matched deterministic replay of the supplied canonical chain-2026 event archive, and the restored encrypted private backup tree was byte-identical to the rehearsal source backup.

It does not support claims that the chain can recreate a lost `(R, rho)` opening, that physical audit inputs were truthful, or that a production recovery was performed unless the artifact came from the actual production recovery rehearsal and is bound into the release manifest.
