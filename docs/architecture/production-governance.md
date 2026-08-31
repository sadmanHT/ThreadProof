# Production Charter Governance

ThreadProof separates validator consensus from protocol governance. QBFT validators order and finalize valid transactions; `ThreadProofCharter` decides whether exceptional protocol actions have the required role-diverse approval. A validator key is not a governance credential, and a governance representative does not automatically become a validator.

## Authority boundary

Production deployment is incomplete until bootstrap authority has been retired. The deployment account may temporarily hold OpenZeppelin `DEFAULT_ADMIN_ROLE` and initial operational roles while contracts are created and wired, but it must not remain a parallel authority after the Charter is installed.

After the reviewed bootstrap ceremony:

- `ThreadProofCharter` holds `DEFAULT_ADMIN_ROLE` on `ThreadProofRegistry`, `CredentialRegistry`, `CapacityVault`, and `SubcontractGovernor`.
- `ThreadProofCharter` holds Registry `REGISTRAR_ROLE` and `SUSPENDER_ROLE`.
- `ThreadProofCharter` holds CredentialRegistry `SUSPENDER_ROLE`.
- `ThreadProofCharter` holds CapacityVault `VERIFIER_ADMIN_ROLE` and `PAUSER_ROLE`.
- `ThreadProofCharter` holds SubcontractGovernor `POLICY_ADMIN_ROLE` and `PAUSER_ROLE`.
- the bootstrap deployer holds none of those roles.
- the bootstrap deployer does not retain `CERTIFIER_ROLE`.

The Charter may delegate only narrowly scoped operational roles through its governed `ProtocolRoleUpdate` action:

- CredentialRegistry `ISSUER_ROLE`;
- CapacityVault `CERTIFIER_ROLE`;
- CapacityVault `RELAYER_ROLE`.

The Charter execution path deliberately refuses to delegate admin, pauser, verifier-admin, policy-admin, registrar, or suspender roles to ordinary accounts. `ISSUER_ROLE` and `CERTIFIER_ROLE` grants also require the target account to belong to an active auditor/independent organization in `ThreadProofRegistry`.

## Governed privileged actions

Proposal policies are snapshotted when a proposal is created. Later policy changes cannot silently alter an already-created proposal.

| Action | Default approval rule | Default delay |
| --- | --- | --- |
| Organization emergency suspension | auditor + regulator | none |
| Organization restore | 3 constituencies, auditor + regulator required | 6 hours |
| Primary-account rotation | 3 constituencies, auditor required | 6 hours |
| Protected identity disclosure | 3 constituencies, auditor + regulator required | 1 hour |
| Factory onboarding | industry + auditor | none |
| Charter policy update | 4 of 5 constituencies | 24 hours |
| Operational protocol role update | 4 of 5, auditor + regulator required | 24 hours |
| ZK verifier registration | 4 of 5, auditor + regulator required | 24 hours |
| Subcontract policy registration | 4 of 5, auditor + regulator required | 24 hours |
| Emergency pause | 3 independent constituencies | none |
| Emergency unpause | 3 constituencies, auditor + regulator required | 6 hours |
| Emergency credential suspension | auditor + regulator | none |
| Credential restore | 3 constituencies, auditor + regulator required | 6 hours |

These are pilot policies. The Charter can change policy only through its own supermajority/timelocked policy-update path.

## Action commitments

Every proposal commits to exact execution parameters through an action hash. Execution recalculates the action hash and reverts if any target, account, verifier version, artifact hash, verification-key hash, policy parameter, credential identifier, or emergency target differs from the approved payload.

This is important operationally: approval of a human-readable proposal title is not authority to execute arbitrary calldata.

The web governance console computes action hashes by reading/calling the deployed Charter and submits transactions from the connected governance wallet. Supabase membership can decide whether the application exposes the console, but it cannot grant on-chain governance authority.

## Verifier governance

A new circuit version must be a new immutable verifier registration. The governed action commits to:

- circuit version;
- deployed verifier address;
- circuit artifact hash;
- verification-key hash.

`CapacityVault` additionally records the deployed verifier bytecode hash. A circuit version cannot be silently rebound to another verifier. Development Groth16 setup remains test infrastructure; production verifier registration should follow the reviewed ceremony/trusted-setup process before the Charter proposal is created.

## Emergency control

Emergency pause is narrowly scoped. The current Charter can pause:

- `CapacityVault`, stopping new certification/spend operations governed by its `Pausable` boundary;
- `SubcontractGovernor`, stopping new subcontract authorizations.

Pause never deletes events, rewrites active commitments, or changes historical authorization records. Unpause is a separate governed action with a recovery delay and required auditor/regulator participation. Application services must not emulate an unpause by accepting writes in Supabase while the chain remains paused.

## Credential incident control

Credential issuers retain normal issuer authority to revoke credentials they issued. The Charter adds an emergency suspension/restoration path for incidents that require independent consortium intervention. Revocation remains terminal under `CredentialRegistry`; the Charter cannot restore a revoked credential by pretending it was merely suspended.

## Bootstrap ceremony checklist

For a production deployment, record and independently review all of the following before declaring governance active:

1. Verify chain ID and deployed bytecode for Registry, CredentialRegistry, OrderRegistry, CapacityVault, SubcontractGovernor, Charter and every approved verifier.
2. Verify the Charter immutable target addresses point to the intended Registry/CredentialRegistry/CapacityVault/SubcontractGovernor contracts.
3. Grant the Charter `DEFAULT_ADMIN_ROLE` on each AccessControl protocol contract.
4. Grant the Charter the exceptional roles listed above.
5. Seed only explicitly approved operational accounts through reviewed bootstrap transactions or, preferably, later Charter `ProtocolRoleUpdate` proposals.
6. Revoke the bootstrap deployer's operational and exceptional roles.
7. Revoke the bootstrap deployer's `DEFAULT_ADMIN_ROLE` last on each contract.
8. Query `hasRole` directly from the consortium chain and archive the resulting transaction hashes and block numbers.
9. Verify that a direct privileged call from the former deployer now reverts.
10. Verify that a below-threshold Charter action, a premature timelocked action, and an action-hash mismatch all revert.

If any of these checks fail, the deployment is not governance-complete and must not be treated as production-ready.

## Read models

`governance_proposal_read_model` and `chain_events` are rebuildable indexed observations. They are useful for dashboards and audit reconstruction, but no row can create an approval, satisfy a threshold, shorten a timelock, delegate a role, register a verifier, pause/unpause a protocol contract, or alter credential status. Critical clients should read the Charter and target contracts directly when deciding whether a privileged action is current or executable.
