# Worker crash safety and claim leases

ThreadProof workers coordinate expensive proof generation and transaction relay through rebuildable PostgreSQL job rows. Those rows are operational state only. They never decide canonical order, capacity, credential, nullifier, or governance state; the blockchain remains authoritative.

## Renewable claims

A claimed job carries a random `worker_claim_token` and `worker_claimed_at`. Long-running workers renew `worker_claimed_at` only while the row still has the expected status and exact token. Production defaults are:

- `THREADPROOF_WORKER_LEASE_SECONDS=3600`
- `THREADPROOF_WORKER_HEARTBEAT_SECONDS=30`

Runtime validation requires at least three heartbeat opportunities within one lease. A worker that cannot renew safely treats ownership as lost and stops publishing results. Another worker may reclaim a claim only after its lease expires.

The heartbeat is an efficiency mechanism, not the correctness boundary. CPU-heavy proving can delay JavaScript timers, so proof generation also re-asserts ownership at explicit persistence boundaries.

## Proof generation publication

Groth16 proving can run much longer than a normal request. A stale worker must never overwrite the private next-capacity opening after another worker has reclaimed the job.

`finalize_proof_generation(...)` publishes the generated proof, public inputs, and encrypted next private state in one PostgreSQL transaction. It succeeds only when the proof job is still `generating` and still carries the caller's exact claim token. If ownership was lost, the function returns `false` and the stale worker discards its result.

This function does not advance canonical capacity. The encrypted next opening remains staged until a canonical `CapacitySpent` event reconciles it.

## Transaction broadcast boundary

Order relays and proof submission renew their claim through validation, signer access, and contract simulation. Immediately after `writeContract` returns a transaction hash, the claim heartbeat stops and the hash is persisted before waiting for a receipt.

That transaction hash is the crash-recovery boundary. A process crash after broadcast must never make an already-sent transaction appear unsent and eligible for blind replay.

If the database cannot persist a proof-spend hash after broadcast, the worker does not perform an unguarded fallback update. The canonical `CapacitySpent` reconciliation trigger can recover a generated/submitted proof job by its nullifier, then validates old commitment, new commitment, order commitment, order ID, and circuit version before confirming the job or touching the private mirror.

Order relay event recovery follows the same principle: canonical contract events settle the application read model; Postgres does not invent a successful chain transaction.

## Failure behavior

- Lease renewal failure before broadcast: fail closed and stop work; no transaction is sent.
- Claim lost during proof generation: discard generated output unless the claim-token-guarded atomic finalizer succeeds.
- Signer unavailable before broadcast: release the claim for retry without local-key fallback.
- Transaction hash exists: persist it immediately and let canonical event indexing settle final state.
- Transaction hash exists but persistence fails: do not blindly overwrite a potentially reclaimed row; rely on canonical event recovery and operator observability.
- Canonical event and staged proof disagree: quarantine the job as stale rather than changing chain-derived state to fit the database.

These rules preserve the ThreadProof trust boundary: workers coordinate work, while contracts and canonical events determine shared protocol truth.
