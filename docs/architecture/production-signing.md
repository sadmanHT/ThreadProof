# Production signing and secret boundaries

ThreadProof uses different signing/key domains for different authorities. They must not collapse into one application secret.

## Authority separation

| Authority | Production holder | Application access |
| --- | --- | --- |
| Buyer/factory/governance user signatures | User-controlled EVM wallet | Browser requests a signature; no private key is stored by ThreadProof |
| Machine transaction relayer | Web3Signer backed by AWS KMS/HSM-class custody | Order relayer / proof submitter receive signer URL + public address only |
| Besu validator/node identity | Consortium node operator | Mounted into Besu only; never exposed to web/worker/Supabase |
| ZK factory nullifier secret | Isolated proof generator secret store | Proof generator only; never Web3Signer or browser |
| Capacity/order decryption key | Isolated proof generator / approved server crypto boundary | Never Web3Signer; never blockchain |
| Supabase service role | Server/worker secret store | Never browser; has no blockchain signing authority |

## Production process split

```text
Encrypted capacity/order data + nullifier secret
                 |
                 v
        [ Proof generator ]
        signer mode: disabled
                 |
          proof + public inputs
                 v
              Supabase
      coordination/staging only
                 |
                 v
        [ Proof submitter ] ------> [ Web3Signer ] ------> AWS KMS
        no witness secrets                |
                 |                        | signed raw tx
                 +------------------------v
                                      [ Besu ]
                                         |
                                  CapacitySpent event
                                         |
                                         v
                                     [ Indexer ]
                                         |
                           rebuildable/read-model reconciliation
```

The proof generator is explicitly rejected at startup if configuration grants it remote or local signing authority. The proof submitter is rejected unless it has a signer, and production rejects raw private-key mode entirely.

## Fail-closed rules

1. The canonical Besu RPC chain ID must match `THREADPROOF_CHAIN_ID` when configured.
2. A remote signer must report the same downstream `eth_chainId` as the canonical Besu RPC.
3. The configured relayer address must appear in Web3Signer's `eth_accounts` response.
4. No transaction is treated as confirmed merely because a submitter returned a hash. The chain event/indexer path settles the operational read model.
5. If a canonical capacity spend is indexed but the encrypted next opening is unavailable, ThreadProof records the new public commitment and changes the private opening to `recertification_required`; it never fabricates witness material.
6. Supabase coordination rows cannot override chain state, credentials, governance, nullifiers, or proof validity.

## Local development exception

`THREADPROOF_SIGNER_MODE=local-dev` is retained so deterministic local transaction tooling can use disposable keys. The proof generator itself still requires `disabled` signer mode. Environment validation rejects `local-dev` transaction submission in staging or production. Development keys must never be promoted into a deployed environment.
