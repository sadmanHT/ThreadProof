# ThreadProof

ThreadProof is a confidential capacity-governance system for apparel supply chains. Hyperledger Besu is the canonical shared state; Supabase is used for private operational data and read models and must never override blockchain authorization state.

## Core protocol

- `ThreadProofRegistry` manages consortium organizations and active signing accounts.
- `CredentialRegistry` records attributable, revocable credential commitments and scopes.
- `OrderRegistry` records buyer-authorized order versions using EIP-712 signatures.
- `CapacityVault` treats certified capacity as a confidential, stateful commitment. Successful PoFC spends consume a nullifier, advance the canonical commitment, and record an immutable on-chain `CapacityAllocation` reference containing commitments/IDs only.
- `SubcontractGovernor` authorizes parent → child production relationships from current buyer-authorized orders, active factory organizations, policy-scoped compliance/process credentials, a canonical PoFC allocation reference, and an EIP-712 approval from the parent factory. Amendments, cancellation, suspension, or credential revocation fail closed when authorization is re-evaluated.

ThreadProof does **not** put exact production capacity, exact subcontract allocation quantities, prices, full confidential order terms, or protected supplier identity material on chain.

The current subcontract layer also does **not** prove `sum(subcontract allocations) = parent workload`. That confidential allocation-sum invariant requires a separately reviewed ZK allocation circuit before it may be claimed.

## Validation status

The subcontract authorization contract suite covers the canonical happy path plus unknown/cancelled/amended orders, inactive or wrong-role factories, missing/revoked policy credentials, invalid PoFC allocation references, maximum depth, cycles/re-parenting, parent-factory signatures, and replay protection. Local deployment includes `SubcontractGovernor`.

## Development

Install dependencies with the pinned workspace package manager and use the repository scripts/CI for web, worker, contracts, and circuit validation. Local contract deployment intentionally uses `MockCapacitySpendVerifier`; it is development-only and is not a production ZK verifier.
