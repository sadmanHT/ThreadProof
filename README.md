# ThreadProof

ThreadProof is a privacy-preserving capacity governance protocol for responsible apparel supply chains. It combines a permissioned blockchain, zero-knowledge proofs, verifiable credentials, and selective disclosure so buyers can validate certified production capacity without exposing a factory's full production book.

## Core trust boundary

The blockchain decides what capacity state is current. Zero-knowledge proofs prove hidden capacity transitions are valid. Auditors establish initial physical capacity claims. Credentials and signed orders establish authority. Governance controls exceptional powers. Supabase and the application coordinate these workflows but never replace canonical chain state.

## Repository

- `apps/web` — Next.js application and consortium workspaces.
- `apps/worker` — proof generation/submission, order relay, and chain indexing workers.
- `packages/contracts` — Solidity protocol contracts and tests.
- `packages/circuits` — CapacitySpend Circom circuit and proof tooling.
- `supabase/migrations` — coordination/read-model schema and RLS hardening.
- `docs/architecture` — protocol and production trust-boundary documentation.
- `infrastructure/besu/production` — fail-closed Besu + Web3Signer production deployment template.

## Production signing

Production machine transactions use an isolated external signer rather than in-process private keys. Proof generation is a separate process with transaction signing disabled; order relay/proof submission use Web3Signer and a public relayer address only. See `docs/architecture/production-signing.md` and `infrastructure/besu/production/README.md`.

## Development

Install the pinned workspace dependencies and run the individual packages through pnpm. Environment variable names and safe placeholders are documented in `.env.example`; real credentials and private keys must not be committed.

```bash
pnpm install --frozen-lockfile
pnpm --filter @threadproof/web dev
pnpm --filter @threadproof/worker typecheck
pnpm --filter @threadproof/contracts test
pnpm --filter @threadproof/circuits test
```

CI validates the web application, browser auth-boundary tests, workers, smart contracts, circuit invariants/generated Groth16 proof integration, secret scans, and production signing/infrastructure boundaries.
