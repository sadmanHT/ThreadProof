# ThreadProof production Besu + remote signer template

This directory defines the production trust boundary for ThreadProof chain access. It is a deployment template, not a ready-made consortium network: the approved QBFT genesis, validator node identity key, static peer list, TLS material, and Web3Signer key configuration must be provisioned by operators outside Git.

## Boundary

- **Besu is canonical.** Application and Supabase state remain coordination/read models only.
- **Workers never receive production transaction private keys.** `THREADPROOF_SIGNER_MODE=remote` points the order relayer and proof submitter at Web3Signer; the worker holds only the public relayer address.
- **Proof generation and proof submission are separate processes in production.** Run the proof generator with `THREADPROOF_SIGNER_MODE=disabled`; give its witness/decryption secrets only to that process. Run `pnpm --filter @threadproof/worker submit:proofs` with remote signer configuration and without witness secrets.
- **Web3Signer owns KMS/HSM access.** The example key metadata uses AWS KMS `SECP256K1` with environment/IAM authentication, so no AWS access key or Ethereum private key is committed here.
- **Besu validator identity is separate from the transaction relayer.** Mount each node's P2P/QBFT node key as an operator secret. Do not reuse the Web3Signer relayer key as a validator node key.

## Required operator inputs

Before starting this stack, provision:

1. `genesis.json` generated and approved for the consortium's QBFT validator set and chain ID `2026`.
2. A unique Besu node private key at `THREADPROOF_BESU_NODE_KEY_PATH`.
3. A reviewed `static-nodes.json` containing only approved consortium peers. The repository default is `[]`, intentionally isolating the node until configured.
4. A Web3Signer key config directory at `THREADPROOF_WEB3SIGNER_KEY_CONFIG_DIR`. Copy `web3signer/aws-kms-key.example.yaml` into that ignored directory and replace only the KMS key identifier/region metadata.
5. IAM/KMS policy allowing Web3Signer to sign with only the designated execution-layer key. Prefer workload identity/instance roles over static cloud credentials.
6. Network controls. The sample Compose file binds Besu JSON-RPC, WebSocket, and Web3Signer HTTP to loopback only. Put authenticated TLS/mTLS reverse proxies or private service networking in front when these services span hosts.

## Worker production environment

```env
THREADPROOF_DEPLOYMENT_ENV=production
THREADPROOF_CHAIN_ID=2026
THREADPROOF_RPC_URL=https://rpc.internal.threadproof.example
THREADPROOF_SIGNER_MODE=remote
THREADPROOF_SIGNER_URL=https://signer.internal.threadproof.example
THREADPROOF_RELAYER_ADDRESS=0x...
# THREADPROOF_RELAYER_PRIVATE_KEY must be absent.
```

The worker validates this policy at startup. `local-dev` signing is rejected outside `development`, and remote mode rejects any raw relayer private key.

## Start/check

```bash
docker compose -f infrastructure/besu/production/docker-compose.yml config
docker compose -f infrastructure/besu/production/docker-compose.yml up -d
curl --fail http://127.0.0.1:9000/upcheck
```

`upcheck` confirms the signer process is healthy, but ThreadProof also calls `eth_accounts` before every signing session and fails closed unless the configured relayer address is actually exposed by the signer.

## Version pins

- Besu: `26.7.1`
- Web3Signer: `26.4.2-distroless`

Upgrade these pins deliberately after reviewing release/security notes and testing the exact versions in staging.
