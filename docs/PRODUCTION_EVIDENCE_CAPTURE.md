# Production Evidence Capture

ThreadProof's production release gates already validate final `threadproof-production-deployment/v1` evidence. The capture helper in this repository has a narrower purpose: it reduces transcription error when an operator is collecting machine-observable deployment facts.

Its output format is deliberately different:

```text
threadproof-production-evidence-capture/v1
```

Every capture is emitted with:

```json
{
  "result": "incomplete",
  "completion": "operator-review-required"
}
```

A capture is **not** production approval, deployment attestation, stakeholder UAT, governance evidence, or proof that an infrastructure operator is independent or honest.

## What the capture can observe

Against an operator-selected ThreadProof RPC, the helper checks and records:

- chain ID `2026`;
- block-0 genesis hash;
- latest canonical block number and hash;
- the exact six release-manifest state-contract addresses and `keccak256(runtime bytecode)` hashes;
- CapacitySpend and CapacityRelease verifier addresses and runtime hashes;
- verifier-wrapper commitments for the circuit artifact, verification key, build attestation and ceremony evidence;
- the matching CapacityVault verifier-provenance registration for the configured circuit version.

The tool does not accept an arbitrary contract list. Addresses come from the supplied production release manifest and are restricted to:

1. `Registry`
2. `CredentialRegistry`
3. `OrderRegistry`
4. `CapacityVault`
5. `SubcontractGovernor`
6. `ThreadProofCharter`
7. CapacitySpend verifier
8. CapacityRelease verifier

The release manifest supplied to the capture command must already contain a concrete semantic release version, exact 40-hex `sourceDevelopCommit`, chain ID 2026, genesis hash, and the eight concrete deployment addresses. Existing concrete runtime/provenance hashes are checked when present. This makes the capture a verification-and-collection step for an operator-selected release candidate rather than a network-discovery tool.

## Optional sanitized operational observation

With `--include-supabase`, the helper performs exactly two server-side REST reads. It does not perform arbitrary SQL and does not inspect arbitrary tables.

`worker_runtime_heartbeats` is limited to:

```text
worker_type
status
chain_id
build_commit
started_at
last_heartbeat_at
last_success_at
error_code
```

The latest heartbeat is selected for each required worker type:

- `indexer`
- `order_relayer`
- `subcontract_relayer`
- `proof_generator`
- `proof_submitter`
- `capacity_release_generator`
- `capacity_release_submitter`

`chain_indexer_cursors` is limited to:

```text
chain_id
last_block_number
last_block_hash
status
error_code
updated_at
```

The helper then reads the cursor block from the canonical RPC and records whether the stored hash matches it. Confirmation depth comes from explicit `THREADPROOF_CONFIRMATIONS`; it is not invented from Supabase state.

The capture never requests `error_detail`, order bodies, private capacity openings, credential bodies, protected identities, AI prompts/results, authentication tables, factory nullifier secrets, witness encryption material, or signer credentials.

Supabase remains a non-authoritative operational/read-model source. The chain remains the shared canonical authority.

## Secret boundary

Do not pass secrets on CLI arguments. The CLI accepts only:

```text
--manifest <path>
--output <path>
--include-supabase
```

RPC/Supabase configuration is supplied through the process environment:

```text
THREADPROOF_RPC_URL
THREADPROOF_CONFIRMATIONS          # required only with --include-supabase
SUPABASE_URL                       # required only with --include-supabase
SUPABASE_SERVICE_ROLE_KEY          # required only with --include-supabase
```

`SUPABASE_SERVICE_ROLE_KEY` is used only in request headers. The output never contains it. The helper also rejects credential-bearing URLs and recursively scans the capture artifact for secret-like keys/values.

Do not give this process:

- `THREADPROOF_RELAYER_PRIVATE_KEY`;
- Web3Signer/KMS/HSM credentials;
- `THREADPROOF_FACTORY_SECRETS_JSON`;
- `THREADPROOF_DATA_KEY_BASE64`;
- protected-identity encryption keys;
- Gemini/other API keys;
- browser/session passwords.

They are unnecessary for evidence capture.

## Operator command

From the repository root after the frozen lockfile has been installed:

```bash
THREADPROOF_RPC_URL='https://trusted-rpc.example.invalid' \
  pnpm evidence:capture:production -- \
  --manifest release/production-release.json \
  --output ./private-operator-work/deployment-capture.json
```

To include the narrow operational read:

```bash
THREADPROOF_RPC_URL='https://trusted-rpc.example.invalid' \
THREADPROOF_CONFIRMATIONS='2' \
SUPABASE_URL='https://project-ref.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<server-side secret from the operator secret store>' \
  pnpm evidence:capture:production -- \
  --manifest release/production-release.json \
  --output ./private-operator-work/deployment-capture.json \
  --include-supabase
```

The command prints only a sanitized completion line containing the capture status and byte count. It does not print RPC/Supabase URLs or secret values.

Keep working capture files out of Git until they have been reviewed and transformed into the intentionally sanitized final evidence contract.

## What still requires independent evidence

The capture always includes an `operatorReviewRequired` list. In particular, it does **not** establish or auto-assert:

- validator administrative independence;
- TLS/private-network controls;
- node/account permissioning;
- persistent-storage and monitoring controls;
- backup configuration or recovery rehearsal;
- remote Web3Signer plus KMS/HSM custody;
- evidence URLs and independent digests;
- reviewer identities or role-diverse signoff;
- stakeholder UAT/adversarial execution;
- final production `result: pass` or approval.

Those facts must be established separately by the appropriate operators/consortium participants and reviewed under the existing release process.

## From capture to final deployment evidence

Do not rename the capture JSON to `deployment-evidence.json` and do not change `result` from `incomplete` to `pass`.

Instead:

1. Review the capture against the exact release source and deployment.
2. Independently establish the controls listed in `operatorReviewRequired`.
3. Prepare the final sanitized `threadproof-production-deployment/v1` artifact using the existing production deployment evidence contract.
4. Add the required evidence URLs/digests and independent signoff.
5. Bind the exact final bytes to `release/production-release.json`.
6. Run the existing release-bound production deployment verifier and Production Readiness gates.

The capture helper is deliberately unable to replace those steps.

## Offline regression tests

The capture policy and live adapter have deterministic fixture-backed tests. They require no production RPC, Supabase secret, paid hosting, or production ceremony material:

```bash
pnpm evidence:test:capture
```

The adversarial suite covers wrong-chain RPCs, missing deployed bytecode, verifier/vault provenance mismatches, stale/wrong-chain worker telemetry, source-commit mismatch, quarantined or non-canonical indexer cursors, insufficient confirmation distance, over-broad/private Supabase fields, credential-bearing URLs, secret-bearing output, and attempts to turn a capture into final approval evidence.
