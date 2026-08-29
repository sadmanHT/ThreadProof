# ThreadProof

**Confidential Capacity Governance for Responsible Apparel Supply Chains**

ThreadProof is a privacy-preserving consortium blockchain network for governing production feasibility, subcontracting, compliance credentials, buyer amendments, and shared accountability across apparel supply chains.

Its core protocol, **Proof-of-Feasible-Capacity (PoFC)**, treats independently certified production capacity as confidential, non-transferable state that can be consumed exactly once. Zero-knowledge proofs establish that an order can be accepted without revealing exact capacity, remaining capacity, competing buyers, or commercially sensitive production books.

## Product direction

ThreadProof is being built as a real product, not a competition-only simulation. The initial implementation targets:

- Next.js + TypeScript application
- Supabase Auth/PostgreSQL for authorized private application data
- Hyperledger Besu permissioned EVM network with QBFT consensus
- Solidity smart contracts for registry, credentials, orders, capacity, subcontracting, and governance
- Circom + snarkjs Groth16 zero-knowledge proofs
- W3C Verifiable Credentials-aligned compliance and capacity credentials
- auditable multi-party governance through the ThreadProof Charter

## Team

**EndGame**  
Md. Sadman Hasan Talukder  
Islamic University of Technology

## Status

Active product development. Architecture and protocol interfaces are being stabilized before infrastructure and production deployment.
