# ThreadProof System Architecture

## 1. Architectural objective

ThreadProof is a multi-organization coordination system, not a database replicated for convenience. The architecture separates four kinds of authority:

1. **Physical-world attestation** — auditors, regulators and other recognized issuers determine facts they are qualified to assess.
2. **Private operational state** — buyers and factories retain purchase-order details, exact capacity openings, prices, evidence and protected identities in authorized systems.
3. **Cryptographic computation** — zero-knowledge circuits transform private witness values into proofs about feasibility without publishing those witness values.
4. **Canonical shared state** — a permissioned blockchain decides which commitments, credentials, authorization paths and governance actions are currently valid across organizations.

The blockchain is authoritative only for shared digital state. It is deliberately not described as an oracle for physical truth.

## 2. Production topology

```text
Buyer / Factory / Auditor / Regulator / Labor / Industry users
                         |
                         v
                Next.js role portals
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
 Authentication     Application API    Signer adapter
 (Supabase Auth)    / orchestration    / KMS-HSM boundary
        |                |                |
        |          +-----+-----+          |
        |          |           |          |
        v          v           v          v
   PostgreSQL   ZK worker   Event indexer  EVM RPC
   encrypted      |             ^           |
   private data   |             |           |
                  v             |           v
          CapacitySpend proof   |    Hyperledger Besu
                  |             |    permissioned network
                  +-------------+-----------+
                                |
               +----------------+----------------+
               |                |                |
               v                v                v
        Identity/Credential   Orders/Capacity   Charter/Governance
             contracts          contracts          contracts
```

## 3. Contract ownership of shared state

### ThreadProofRegistry
Owns consortium organization identity, role, active/suspended/revoked status and the currently recognized transaction-signing account. Key rotation changes the account associated with an organization without rewriting history.

### CredentialRegistry
Owns credential identifier, issuer, subject, type, integrity digest, validity interval and live status. Full VC bodies and audit evidence remain private. Every new authorization checks current status rather than trusting a cached UI badge.

### OrderRegistry
Will own order commitments, immutable version lineage, buyer signatures and lifecycle status. Confidential commercial terms remain off-chain.

### CapacityVault
Owns the only spendable capacity commitment for every `Factory × Period × Process` key, the nullifier registry, circuit-version binding and the accepted proof-driven state transition. This is the technical core of ThreadProof.

### SubcontractGovernor
Will own parent-child production authorization, maximum depth, required credential policy and capacity authorization references.

### ThreadProofCharter
Will own governed proposals, role-diverse approvals, timelocks and execution authority for upgrades, suspensions, emergency controls and protected identity disclosure.

## 4. PoFC transaction path

A capacity spend follows a fail-closed path:

1. Buyer and factory establish an order version and its cryptographic commitment.
2. The factory loads the opening of its latest private capacity commitment from authorized encrypted storage.
3. The proof service constructs the `CapacitySpend` witness locally for the factory boundary.
4. Circom/snarkjs generate a Groth16 proof, next commitment and nullifier.
5. The factory signer (or an explicitly authorized relayer) submits the proof to `CapacityVault`.
6. `CapacityVault` verifies that:
   - the factory organization is active;
   - the caller belongs to the factory or is an authorized relayer;
   - the supplied old commitment is exactly the commitment currently active on-chain;
   - the nullifier has never been used;
   - the capacity credential is still active;
   - the policy and circuit versions match the certified state;
   - every public value is a valid SNARK field element;
   - the Groth16 proof verifies against the registered verifier.
7. Only after all checks succeed does one transaction mark the nullifier used and replace the old commitment with the new commitment.
8. The private application updates its encrypted opening only after the blockchain event is confirmed.

This makes concurrent allocation safe. Two proofs may be generated from the same old state, but only the first accepted transaction can advance the canonical commitment. The second becomes stale and must regenerate from the new state.

## 5. Identifier and field-element discipline

Business identifiers are retained as 32-byte application/blockchain IDs. Circom public signals live in the BN254 scalar field. Contracts therefore deterministically reduce identifier hashes into the SNARK field for proof verification while retaining the original `bytes32` values for business-state keys and event indexing.

Commitments and nullifiers produced by Poseidon are already field elements and are rejected on-chain if they are outside the scalar field. This avoids accidental mismatch between EVM `uint256` values and the proving system.

## 6. Private-data boundary

Supabase/PostgreSQL stores:

- organization profiles and membership;
- complete purchase-order payloads in encrypted form;
- credential bodies/evidence in encrypted form or protected object storage;
- exact private capacity openings and commitment randomness in encrypted form;
- proof job state;
- protected supplier identity mappings;
- indexed blockchain events for search/read performance.

It does **not** become authoritative for the current shared capacity commitment, credential status, order-chain history or governance execution. If private state is altered inconsistently, the next proof cannot open the on-chain commitment.

## 7. Key management

Development may use disposable local private keys. Staging and production must not store consortium signing keys in application environment variables. The target model is:

- organization transaction keys in external wallets, cloud KMS or HSM-backed signers;
- issuer keys separated from ordinary transaction keys;
- validator node keys separated from business-signing keys;
- encryption keys versioned independently from blockchain identities;
- Charter-governed recovery and account rotation;
- no secret committed to Git.

## 8. Network architecture

The target blockchain is a permissioned Hyperledger Besu network using QBFT. A production consortium should have at least four independent validators and preferably five or seven for operational resilience. Validators and business-governance roles are separate concepts: operating a node does not automatically grant authority to issue credentials, suspend a factory or disclose protected data.

Initial role topology:

- Validator A — buyer/consortium participant
- Validator B — industry/factory-side institution
- Validator C — independent auditor institution
- Validator D — regulatory/oversight participant
- Validator E — independent governance/infrastructure participant

Production validators should not all run under one cloud account or administrative identity.

## 9. Failure behavior

ThreadProof prioritizes safety over availability for trust-sensitive writes.

- **Chain unavailable:** do not fall back to local capacity acceptance; queue or reject the operation.
- **Proof stale:** regenerate from the latest confirmed commitment.
- **Credential revoked:** reject new production authorization even if a proof was generated earlier.
- **Private opening lost:** do not invent remaining capacity; recover from protected backup or recertify through governance/auditor process.
- **Issuer key compromised:** suspend issuer, identify dependent credentials from event history, rotate keys and reissue as required.
- **Factory key compromised:** suspend/rotate the organization signing account without deleting historical transactions.

## 10. Build sequence

1. Stabilize registry, credential and capacity contracts with tests.
2. Compile and test `CapacitySpend.circom` with positive and adversarial witnesses.
3. Generate/verifiably reproduce Groth16 setup artifacts and Solidity verifier.
4. Build local five-validator Besu/QBFT network and deployment scripts.
5. Provision dedicated Supabase development environment and apply RLS migrations.
6. Implement organization/auth onboarding and role portals.
7. Implement order/version workflow and EIP-712 signatures.
8. Implement proof orchestration and confirmed-state reconciliation.
9. Implement subcontract authorization.
10. Implement Charter governance and controlled disclosure.
11. Add CI, security testing, backups, observability and staging deployment.
12. Benchmark, audit and pilot with controlled real organizations/data.
