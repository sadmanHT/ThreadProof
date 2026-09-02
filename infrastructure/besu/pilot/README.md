# ThreadProof five-validator QBFT pilot

This directory is the disposable development/pilot counterpart to `infrastructure/besu/production/`. It exists so the complete ThreadProof stack can be exercised against a real multi-validator QBFT chain with the canonical ThreadProof chain ID `2026` without weakening production key-management rules.

## Trust boundary

- The pilot uses **five Besu validators** on one Docker host. It proves multi-validator QBFT behavior, but it is **not an independently administered consortium deployment**.
- Validator keys, the funded deployment key, generated genesis, peer allowlist and runtime manifest are generated under `infrastructure/besu/pilot/runtime/` and are ignored by Git.
- Pilot transaction signing may use the generated raw deployer key because `THREADPROOF_DEPLOYMENT_ENV=development`. Staging and production workers continue to reject raw private-key signing and must use the remote signer/KMS/HSM path.
- The production template remains a separate fail-closed deployment boundary. Do not copy pilot keys, addresses, or runtime files into production.

## QBFT startup peer policy

The five-validator ThreadProof baseline explicitly sets Besu `sync-min-peers=3`. With one validator unavailable, each remaining validator can see only the other three active validators. Requiring four or five sync peers would therefore contradict the documented 4/5 operating case and, with Besu's image default, can make a fresh private chain wait for a peer count it cannot reach.

`sync-min-peers=3` controls **Besu synchronization/startup peer selection only**. It does not change QBFT voting thresholds, validator membership, or consensus quorum. The separate fault-resilience drill still proves that 4/5 validators finalize while 3/5 validators stop finalizing.

A fully healthy pilot is held to a stricter readiness gate than the sync threshold: validator 1 must report all four remote validator peers and the exact five-validator QBFT set. RPC/topology startup gets its own readiness window, and only after that succeeds does ThreadProof begin a separate first-post-genesis-block observation window. This prevents slow container/JVM/peer startup from consuming the consensus-production budget while remaining fail closed if either phase fails.

## Prerequisites

- Docker Engine with Docker Compose v2.
- Node.js 22+.
- Repository dependencies installed with the pinned `pnpm` version when deploying contracts or starting workers.

## Lifecycle

Prepare fresh runtime keys/genesis/permissioning without starting the network:

```bash
pnpm pilot:prepare
```

Start all five validators and wait until validator 1 reports chain `2026`, four peers, five QBFT validators and at least one post-genesis block:

```bash
pnpm pilot:up
```

Re-run only the health gate:

```bash
pnpm pilot:verify
```

Stop containers but retain chain data and runtime material:

```bash
pnpm pilot:down
```

Destroy containers, volumes and all disposable pilot key material:

```bash
pnpm pilot:reset
```

`prepare` writes `runtime/pilot.env` containing the generated funded deployer key and canonical RPC settings. Source that file only for local development tooling:

```bash
set -a
. infrastructure/besu/pilot/runtime/pilot.env
set +a
pnpm --filter @threadproof/contracts deploy:local --network threadproofLocal
```

The current `deploy:local` contract script intentionally installs the development mock capacity verifier. It remains suitable only for contract wiring smoke tests. The PoFC milestone must replace that mock with the exact provenance-bound Groth16 verifier generated from the reviewed circuit artifacts before any result is called a real PoFC transaction.

## What this milestone proves

A passing pilot health gate proves:

1. five generated validator identities match the QBFT genesis validator set;
2. the generated genesis is chain `2026`;
3. discovery-disabled static peering and node permissioning form the expected healthy topology;
4. `sync-min-peers=3` is explicitly bound to the five-validator/one-unavailable startup policy;
5. validator 1 sees the four expected healthy peers;
6. at least one post-genesis QBFT block is finalized in the dedicated block-production window;
7. the same low-level topology validator used by production accepts the generated pilot manifest.

It does **not** prove independent validator failure domains, production KMS/HSM custody, production TLS/mTLS, or a production Groth16 ceremony. Those remain operator/deployment responsibilities.
