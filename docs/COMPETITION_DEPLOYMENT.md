# ThreadProof competition deployment

This runbook is for the Blockchain Olympiad / BCOLBD demonstration of ThreadProof. It is deliberately **not** the production-consortium runbook.

A hosted competition demo may use temporary or single-administrator infrastructure while demonstrating the full protocol mechanics, but it must not be described as proof that five independent consortium organizations operate persistent validators, that production Web3Signer/KMS-HSM custody exists, or that the production Groth16 ceremonies have occurred.

## Authority boundary

Hosting does not change protocol authority:

- the chain is canonical for organization, credential, order, capacity, subcontract and Charter state;
- `CapacityVault` remains the sole canonical capacity-state advancer;
- Supabase/PostgreSQL is private operational state and a disposable/rebuildable read model where applicable;
- web/API RBAC is application authorization, not protocol authorization;
- proof generators may handle private witness material but may not sign transactions;
- submitters/relayers may submit transactions but may not receive private witness/factory secrets;
- AI output is advisory only.

A hosting outage must fail closed for canonical writes. Do not mutate Supabase as a substitute for unavailable QBFT finality and sync it later.

## Deployment classes

The checked-in competition plan uses:

```text
deploymentClass = competition-demo
chain.deployment = disposable-demo
worker deploymentEnvironment = staging
chainId = 2026
```

`staging` is intentional. It activates the worker-side rule that raw private-key signing is forbidden while avoiding a false claim that temporary competition infrastructure is the production consortium.

## Sanitized deployment plan

Start from:

```text
deployment/competition-deployment.example.json
```

The example is intentionally invalid because `sourceCommit` contains `REPLACE_ME`.

Create a sanitized plan containing the exact certified `develop` SHA being demonstrated. The plan contains **environment variable names only**, never values.

Validate it with:

```bash
pnpm competition:preflight -- path/to/competition-deployment.json
```

The preflight enforces eight service profiles:

1. `web-api`
2. `event-indexer`
3. `order-relayer`
4. `subcontract-relayer`
5. `capacity-spend-proof-generator`
6. `capacity-spend-submitter`
7. `capacity-release-proof-generator`
8. `capacity-release-submitter`

The checker rejects unknown environment names, placeholder material, wrong chain ID, missing required contracts/RPC settings, raw private-key variables, signer authority on proof generators, and witness/factory secrets outside proof-generator roles.

## Web/API host

`apps/web` is the Next.js UI **and** HTTP/API layer. It includes `/api/*` routes and server actions, so a second generic API service is not required.

A suitable serverless Next.js host may run this layer. The currently connected Vercel account can be used for the competition web layer, but no ThreadProof Vercel project has been created by repository automation. Import the canonical `sadmanHT/ThreadProof` repository through the hosting provider UI and verify the preview build before promoting it.

At minimum the web/API profile requires:

- public Supabase URL and publishable key;
- server-only Supabase URL and service-role key;
- chain-2026 RPC URL;
- expected public/server chain IDs;
- the six protocol contract addresses;
- application URL.

`GEMINI_API_KEY` and the ThreadProof AI settings are optional web/API server variables when the Intelligence feature is enabled. Never expose the Gemini key through a `NEXT_PUBLIC_*` variable.

The web host must **not** receive:

- `THREADPROOF_RELAYER_PRIVATE_KEY`;
- development account private keys;
- `THREADPROOF_DATA_KEY_BASE64`;
- `THREADPROOF_FACTORY_SECRETS_JSON`;
- identity/private-data encryption keys belonging to separate protected workflows.

## Long-running workers

The indexer, relayers, proof generators and submitters are continuously running Node processes. Do not place them in a serverless web function and assume it is equivalent to a persistent worker.

The audited commands are:

```text
pnpm --filter @threadproof/worker index
pnpm --filter @threadproof/worker relay:orders
pnpm --filter @threadproof/worker relay:subcontracts
pnpm --filter @threadproof/worker proof
pnpm --filter @threadproof/worker submit:proofs
pnpm --filter @threadproof/worker release:proof
pnpm --filter @threadproof/worker submit:releases
```

### Proof generators

Only the two proof-generator roles may receive:

```text
THREADPROOF_DATA_KEY_BASE64
THREADPROOF_FACTORY_SECRETS_JSON
```

Their signer mode must be `disabled`. A proof generator can produce a valid proof; it cannot decide that the proof targets the current canonical commitment and cannot submit a transaction by itself.

### Transaction relayers/submitters

Order, subcontract, capacity-spend and capacity-release submitters use `remote` signing in the competition staging profile. They receive:

```text
THREADPROOF_SIGNER_URL
THREADPROOF_RELAYER_ADDRESS
```

They must not receive a raw relayer private key or private witness/factory-secret material.

### Indexer

The indexer is read-only with respect to protocol authority. Its Supabase projections and cursor/read models may be rebuilt from canonical events. A database edit cannot alter the state that contracts accept.

## Chain host

The repository's five-validator Chain-2026 pilot is disposable and is excellent competition evidence, but a GitHub Actions runner is not a persistent public RPC host.

For a live presentation, choose one of these honestly described arrangements:

- run the disposable five-validator chain and worker plane on a presenter-controlled machine during the demo;
- use a temporary VM/container host supplied by the team and expose only the RPC endpoint required by the web/API;
- use a persistent host if one is available, while still describing it as a competition/demo deployment unless the production acceptance criteria are actually met.

Do not call five containers on one administrative host “five independently administered consortium validators.” They demonstrate QBFT mechanics, not organizational independence.

## Current hosting constraint

On 2026-09-02 the connected Railway account rejected creation of a new ThreadProof project because its trial had expired. Railway is therefore **not a required dependency** of the free competition path. Do not change the protocol or secret boundaries to fit a particular hosting provider.

The current connected Supabase organization is on the Free plan. That is sufficient for competition development/demo state, but production release issue #23 remains blocked because leaked-password protection is a Pro-or-above feature and the current security advisor still reports it disabled.

## Pre-deployment sequence

1. Freeze the exact certified `develop` SHA for the demo.
2. Generate the disposable chain-2026 topology and deploy the protocol contracts.
3. Record the six deployed contract addresses and an RPC endpoint reachable by the web/worker plane.
4. Create a sanitized competition deployment plan using environment **names only**.
5. Run the competition preflight and normal ThreadProof CI.
6. Configure actual secret values directly in each host's protected environment store; never commit them.
7. Start the indexer before accepting user-facing activity so the read model can catch up.
8. Start proof generators with signing disabled.
9. Start relayers/submitters with remote signing only.
10. Deploy the Next.js web/API and verify `/api/health` and chain status against chain ID 2026.
11. Execute the competition end-to-end path and retain the GitHub/live-pilot evidence separately from hosting screenshots.

## What this deployment proves

A successful hosted competition run can demonstrate that:

- the UI/API can coordinate the ThreadProof workflows;
- the five-validator QBFT pilot finalizes canonical transactions;
- PoFC consumes the current confidential capacity state without revealing the private opening;
- stale/replayed state is rejected;
- subcontract, credentials, amendments/releases and Charter governance obey their separate authority boundaries;
- worker/read-model services fail closed around canonical chain state.

It does **not** prove real factory truth, independent validator administration, production key custody, independent ceremony honesty, continuous worker welfare, or any fact outside ThreadProof's Oracle Boundary.
