# ThreadProof QBFT Fault-Resilience Evidence

ThreadProof separates **consensus safety** from **service liveness**. A responsive JSON-RPC endpoint is not sufficient evidence that new protocol transitions can be finalized.

The reference pilot has five QBFT validators on chain ID `2026`. The canonical fault-resilience harness is:

```bash
pnpm pilot:up
pnpm --filter @threadproof/worker test:runtime-readiness
pnpm pilot:fault-resilience
pnpm pilot:reset
```

`pnpm pilot:fault-resilience` deliberately leaves `validator1` running because it is the pilot RPC endpoint and applies the following sequence:

1. Verify the healthy five-validator network advances by at least two post-observation blocks.
2. Stop `validator5` and require the four remaining validators to continue finalizing blocks.
3. Stop `validator4` as well. After a settling interval, require the canonical block height to remain unchanged for the full observation window **while `eth_chainId` still succeeds**.
4. Restart `validator4` and require block finalization to resume.
5. Restart `validator5` and require the fully restored network to continue advancing.

The run writes only non-secret evidence to:

- `infrastructure/besu/pilot/runtime/qbft-fault-resilience.json`
- `infrastructure/besu/pilot/runtime/qbft-fault-resilience.json.sha256`

The JSON records block heights, timing observations, stopped/restarted validator labels, the chain ID, configured validator count, source commit when available, and pass/fail status. It never records validator private keys, deployer keys, RPC credentials, signer credentials, witness values, order payloads, or capacity openings.

## Worker fail-closed rule

A quorum failure can leave an RPC process reachable even though no new block can become canonical. ThreadProof workers therefore monitor both runtime identity and canonical block progress:

- RPC unreachable: unhealthy.
- Wrong chain ID: unhealthy.
- Required contract bytecode missing: unhealthy.
- Canonical block height moves backwards: unhealthy.
- Canonical block height fails to advance for the configured stall threshold: unhealthy.

The default runtime watch checks every 30 seconds and treats 90 seconds without canonical progress as loss of readiness. A worker exits rather than continuing to authorize from Supabase or another local cache. Restart orchestration may bring the process back only after the chain is advancing again.

This does **not** make the worker the authority on consensus. The chain remains authoritative. The monitor only prevents an operational service from treating a reachable-but-stalled RPC as permission to continue processing.

## Production interpretation

The disposable pilot demonstrates the protocol's expected liveness boundary, not production administrative independence. Before production release, operators should repeat an equivalent exercise on the persistent consortium under the approved incident-response plan and archive the evidence URL/hash in the production release package.

A production outage must never trigger any mechanism that directly mutates capacity, credential, order, subcontract, or governance truth in PostgreSQL. Recovery restores canonical chain quorum first; workers then re-establish chain/runtime readiness and resume normal reconciliation.
