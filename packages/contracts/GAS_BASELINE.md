# ThreadProof contract gas baseline

This file records a development baseline from the Hardhat test network. It is evidence for regression tracking, not a gas-optimization target and not a production Besu benchmark.

Measured by `test/GasSnapshot.spec.ts` in ThreadProof CI on 2026-08-29:

| Operation | Gas used |
| --- | ---: |
| Register organization | 119,263 |
| Issue credential | 197,289 |
| Submit buyer-signed order version | 364,477 |
| Certify initial capacity state | 147,611 |
| Spend capacity with **mock verifier** | 115,355 |

## Important limitation

`spendCapacityMockVerifier` does **not** represent final PoFC verification gas. The current test deploys `MockCapacitySpendVerifier`, which only exercises `CapacityVault` state/order/credential/nullifier logic. The final baseline must be updated after `CapacitySpend.circom` is compiled, a real Groth16 Solidity verifier is generated, and `CapacityVault` is tested against that verifier.

The CI test prints a machine-readable line beginning with `THREADPROOF_GAS_SNAPSHOT` so future changes can be compared against this baseline.
