# ThreadProof five-validator QBFT pilot

This directory is the disposable development/pilot counterpart to `infrastructure/besu/production/`. It exists so the complete ThreadProof stack can be exercised against a real multi-validator QBFT chain with the canonical ThreadProof chain ID `2026` without weakening production key-management rules.

## Trust boundary

- The pilot uses **five Besu validators** on one Docker host. It proves multi-validator QBFT behavior, but it is **not an independently administered consortium deployment**.
- Validator keys, the funded deployment key, generated genesis, peer allowlist and runtime manifest are generated under `infrastructure/besu/pilot/runtime/` and are ignored by Git.
- Pilot transaction signing may use the generated raw deployer key because `THREADPROOF_DEPLOYMENT_ENV=development`. Staging and production workers continue to reject raw private-key signing and must use the remote signer/KMS/HSM path.
- The production template remains fail-closed and unchanged. Do not copy pilot keys, addresses, or runtime files into production.

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
3. discovery-disabled static peering and node permissioning form quorum;
4. at least one post-genesis QBFT block is finalized;
5. validator 1 sees the four expected peers;
6. the same topology validator used for production also accepts the generated pilot manifest.

It does **not** prove independent validator failure domains, production KMS/HSM custody, production TLS/mTLS, or a production Groth16 ceremony. Those remain operator/deployment responsibilities.
