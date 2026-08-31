# ThreadProof production Besu + remote signer template

This directory defines the production trust boundary for ThreadProof chain access. It is a per-node deployment template, not a ready-made consortium network: the approved QBFT genesis, validator node identity key, peer allowlist, TLS material, topology manifest, and Web3Signer runtime key configuration must be provisioned by operators outside Git.

## Boundary

- **Besu is canonical.** Application and Supabase state remain coordination/read models only.
- **Production startup is topology-gated.** Compose runs a network-isolated one-shot preflight before Besu. The preflight requires an approved QBFT genesis hash, at least four distinct validators, all remote validators as static peers, and agreement between the topology manifest, `static-nodes.json`, and the Besu node allowlist. Besu does not start when those checks fail.
- **Workers never receive production transaction private keys.** `THREADPROOF_SIGNER_MODE=remote` points the order relayer and proof submitter at Web3Signer; those workers hold only the public relayer address.
- **Proof generation and proof submission are separate processes in production.** Run the proof generator with `THREADPROOF_SIGNER_MODE=disabled`; give witness/decryption/nullifier secrets only to that process. Run `pnpm --filter @threadproof/worker submit:proofs` with remote signer configuration and without witness secrets.
- **Web3Signer owns KMS/HSM access.** The example key metadata uses AWS KMS with environment/default-provider authentication, so no AWS access key or Ethereum private key is committed here.
- **Besu validator identity is separate from the transaction relayer.** Mount each node's P2P/QBFT node key as an operator secret. Do not reuse the Web3Signer relayer key as a validator node key.
- **Peer admission is fail-closed.** Discovery is disabled and Besu local node permissioning is enabled. The tracked `static-nodes.json` and `permissions_config.toml` are intentionally empty placeholders; the startup preflight rejects them until an operator supplies the reviewed consortium set.
- **Capacity spend reconciliation is event-derived.** The proof submitter broadcasts and observes receipts; the indexed canonical `CapacitySpent` event atomically advances or quarantines the private operational mirror.

## Consortium topology contract

Every deployed node needs an operator-controlled topology manifest based on `consortium-topology.example.json`. The manifest is not secret; it records approved public network identity and must contain:

- chain ID `2026` and consensus `qbft`;
- the SHA-256 digest of the exact approved `genesis.json` bytes;
- the stable name of the local node for that host;
- at least four validator enodes, giving QBFT one-validator-fault tolerance;
- any approved observer/RPC nodes.

Validator node identities must be distinct. On each host, `static-nodes.json` must include every **remote** validator because discovery is disabled. Every static peer must also appear in `nodes-allowlist`, and neither file may contain a peer absent from the topology manifest. The preflight verifies all of these conditions before Besu starts.

The topology manifest does **not** prove that four validators run on independent infrastructure. Production operators must place validators across separately administered failure domains/hosts and enforce network controls outside Docker. Running four containers on one machine is not a resilient consortium deployment.

## Required operator inputs

Before starting this stack, provision:

1. `genesis.json` generated and approved for the consortium's QBFT validator set and chain ID `2026`.
2. A topology manifest copied from `consortium-topology.example.json`, populated with the public validator/observer enodes and the SHA-256 digest of the exact approved genesis. Each host sets its own `localNode` while keeping the approved validator set and genesis digest consistent.
3. A unique Besu node private key at `THREADPROOF_BESU_NODE_KEY_PATH` (or replace file-backed validator identity with an approved Besu HSM/security-module deployment).
4. Reviewed `static-nodes.json` **and** `permissions_config.toml` containing the approved consortium enode URLs. Do not use the tracked empty placeholders in a deployment.
5. A Web3Signer key config directory at `THREADPROOF_WEB3SIGNER_KEY_CONFIG_DIR`. Copy `web3signer/aws-kms-key.example.yaml` into the ignored runtime `web3signer/keys/` directory and replace the KMS key identifier/region metadata.
6. IAM/KMS policy allowing Web3Signer to sign with only the designated execution-layer key. Prefer workload/instance/task roles over static cloud credentials.
7. Network controls. The sample Compose file binds Besu JSON-RPC, WebSocket, and Web3Signer HTTP to loopback only. Put authenticated TLS/mTLS reverse proxies or private service networking in front when these services span hosts.

Example runtime paths, all outside Git:

```env
THREADPROOF_CHAIN_ID=2026
THREADPROOF_CONSORTIUM_TOPOLOGY_PATH=/secure/threadproof/validator-a/topology.json
THREADPROOF_BESU_GENESIS_PATH=/secure/threadproof/network/genesis.json
THREADPROOF_BESU_NODE_KEY_PATH=/secure/threadproof/validator-a/node-key
THREADPROOF_BESU_STATIC_NODES_PATH=/secure/threadproof/validator-a/static-nodes.json
THREADPROOF_BESU_PERMISSIONS_PATH=/secure/threadproof/validator-a/permissions_config.toml
THREADPROOF_WEB3SIGNER_KEY_CONFIG_DIR=/secure/threadproof/web3signer/keys
```

## Worker production environments

Proof generator (contains witness material, cannot sign):

```env
THREADPROOF_DEPLOYMENT_ENV=production
THREADPROOF_CHAIN_ID=2026
THREADPROOF_RPC_URL=https://rpc.internal.threadproof.example
THREADPROOF_SIGNER_MODE=disabled
# plus proof artifacts, data encryption key, and factory nullifier-secret source
```

Order relayer / proof submitter (can sign, receives no witness secrets):

```env
THREADPROOF_DEPLOYMENT_ENV=production
THREADPROOF_CHAIN_ID=2026
THREADPROOF_RPC_URL=https://rpc.internal.threadproof.example
THREADPROOF_SIGNER_MODE=remote
THREADPROOF_SIGNER_URL=https://signer.internal.threadproof.example
THREADPROOF_RELAYER_ADDRESS=0x...
# THREADPROOF_RELAYER_PRIVATE_KEY must be absent.
```

The worker validates this policy at startup. `local-dev` signing is rejected outside `development`, proof generation rejects all signer access, and remote mode rejects any raw relayer private key. The remote client also verifies both `eth_chainId` and `eth_accounts` before signing.

## Preflight and start

You can run the same topology gate directly from the repository before Compose:

```bash
pnpm infra:validate:consortium
```

The four `THREADPROOF_*_PATH` variables shown above plus `THREADPROOF_CONSORTIUM_TOPOLOGY_PATH` must be set. A successful run reports validator count and the tolerated QBFT fault count. Any topology/genesis/permission disagreement exits non-zero.

Compose runs this validation again automatically as the `topology-preflight` service. Besu depends on its successful completion:

```bash
docker compose -f infrastructure/besu/production/docker-compose.yml config
docker compose -f infrastructure/besu/production/docker-compose.yml up -d
curl --fail http://127.0.0.1:9000/upcheck
```

`upcheck` confirms the signer process is healthy, but ThreadProof additionally checks the signer account and downstream chain ID and fails closed on disagreement.

## Version pins

- Topology preflight runtime: `node:22.19.0-alpine3.22`
- Besu: `26.8.0`
- Web3Signer: `26.4.2-distroless`

Besu 26.8.0 has a documented discovery issue when discovery mode is configured as `BOTH`; this template deliberately disables discovery and uses approved static/permissioned peers. Upgrade any image pin deliberately after reviewing release/security notes and testing the exact version in staging. For production promotion, prefer immutable registry digests in the deployment system after the approved image is mirrored/scanned.
