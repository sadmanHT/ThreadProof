# ThreadProof QBFT Fault-Resilience Evidence

ThreadProof separates **consensus safety** from **service liveness**. A responsive JSON-RPC endpoint is not sufficient evidence that new protocol transitions can be finalized.

The reference pilot has five QBFT validators on chain ID `2026`. The canonical fault-resilience harness is:

```bash
pnpm pilot:up
pnpm --filter @threadproof/worker test:runtime-readiness
pnpm pilot:fault-resilience
pnpm pilot:reset
```

## Startup/sync policy is not consensus quorum

The five-validator ThreadProof baseline pins Besu `sync-min-peers=3`. This is an operational startup/synchronization threshold: when one validator is unavailable, any running validator can connect to only three other active validators. Inheriting a larger image default would conflict with the documented 4/5 availability case and can make a fresh private network wait for an unreachable sync-peer count.

This setting does **not** alter QBFT votes, validator membership, finalization quorum, genesis, or the fail-closed application policy. A healthy five-validator startup is still required to show four remote peers and the exact five-validator QBFT set. The pilot first waits for RPC/topology/peer readiness and then starts a separate first-post-genesis-block observation window. The fault harness below independently proves the consensus boundary: 4/5 continues finalizing; 3/5 must not.

If the approved production validator set changes, operators must deliberately review the sync-peer threshold together with the network policy rather than treating `3` as a universal constant. The production template is only configuration evidence; it is not proof that separately administered production validators exist.

`pnpm pilot:fault-resilience` keeps `validator1` running during the fault observation because it is the pilot RPC endpoint and applies the following sequence:

1. Verify the healthy five-validator network advances by at least two post-observation blocks.
2. Stop `validator5` and require the four remaining validators to continue finalizing blocks.
3. Stop `validator4` as well. After a settling interval, require the canonical block height to remain unchanged for the full observation window **while `eth_chainId` still succeeds**.
4. Start `validator4` to restore the 4/5 quorum. Because QBFT doubles `requesttimeoutseconds` after every failed consensus round, restart the four active validators (`validator1` through `validator4`) to reset their backed-off round timers to the genesis value, wait for RPC identity to return, and require canonical block finalization to resume.
5. Start `validator5` and require the fully restored network to continue advancing.

The active-validator restart in step 4 is an explicit incident-recovery operation, not a consensus shortcut. It does not alter genesis, validator membership, chain data, or application state; it resets local QBFT round timers after the network has crossed the no-quorum boundary. The evidence records which validators were restarted for this timeout reset.

The run writes only non-secret evidence to:

- `infrastructure/besu/pilot/runtime/qbft-fault-resilience.json`
- `infrastructure/besu/pilot/runtime/qbft-fault-resilience.json.sha256`

The JSON records block heights, timing observations, stopped/restarted validator labels, timeout-reset validator labels, RPC recovery timing, the chain ID, configured validator count, source commit when available, and pass/fail status. It never records validator private keys, deployer keys, RPC credentials, signer credentials, witness values, order payloads, or capacity openings.

## Worker fail-closed rule

A quorum failure can leave an RPC process reachable even though no new block can become canonical. ThreadProof workers therefore monitor both runtime identity and canonical block progress:

- RPC unreachable: unhealthy.
- Wrong chain ID: unhealthy.
- Required contract bytecode missing: unhealthy.
- Canonical block height moves backwards: unhealthy.
- Canonical block height fails to advance for the configured stall threshold: unhealthy.

The default runtime watch checks every 30 seconds and treats 90 seconds without canonical progress as loss of readiness. A worker exits rather than continuing to authorize from Supabase or another local cache. Restart orchestration may bring the process back only after the chain is advancing again.

The dedicated CI workflow also exercises this rule against a **live stalled QBFT network**: it removes two validators, keeps JSON-RPC reachable, uses a shortened test-only stall threshold, and requires the worker readiness probe to reject the responsive-but-non-advancing chain. That disposable chain is destroyed before the separate full recovery drill so the two evidence cases cannot contaminate one another.

This does **not** make the worker the authority on consensus. The chain remains authoritative. The monitor only prevents an operational service from treating a reachable-but-stalled RPC as permission to continue processing.

## Production interpretation

The disposable pilot demonstrates the protocol's expected liveness boundary, not production administrative independence. Before production release, operators should repeat an equivalent exercise on the persistent consortium under the approved incident-response plan and archive the evidence URL/hash in the production release package.

A production outage must never trigger any mechanism that directly mutates capacity, credential, order, subcontract, or governance truth in PostgreSQL. Recovery restores canonical chain quorum first. If the outage crossed the QBFT no-quorum boundary, operators should apply the approved coordinated active-validator restart to clear exponentially backed-off round timers. Workers then re-establish chain/runtime readiness and resume normal reconciliation.
