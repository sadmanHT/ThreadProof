# Production deployment evidence

ThreadProof production promotion must not treat a syntactically valid deployment URL as proof that the persistent consortium described by the release manifest is the deployment operators actually reviewed. This procedure defines a sanitized, machine-verifiable deployment record and binds its exact bytes to `release/production-release.json`.

The deployment record is **release evidence, not protocol state**. It can prove that one sanitized artifact consistently describes the reviewed chain, validator topology, signer policy, deployed contract/verifier identities and operational-service health. It cannot provision infrastructure, prove that two declared administrative domains are legally independent, prove the internal behavior of a cloud KMS/HSM, or establish physical-world truth.

## Release binding

For release version `vX.Y.Z`, place the sanitized evidence at exactly:

```text
docs/releases/vX.Y.Z/deployment-evidence.json
```

Compute SHA-256 over those exact file bytes and put the lowercase 64-character digest in:

```text
release.evidence.deploymentManifestSha256
```

Set `release.evidence.deploymentEvidenceUrl` to the HTTPS archive location containing the same sanitized bytes. The production-readiness gate reads the committed file locally and does not fetch a PR-controlled URL. It recomputes the digest before parsing the JSON.

Run the policy tests with:

```bash
node scripts/test-production-deployment-evidence.mjs
node scripts/test-production-deployment-template.mjs
```

A real release branch additionally runs:

```bash
node scripts/verify-release-deployment-evidence.mjs
```

That command intentionally fails on ordinary `develop` checkouts because a real `release/production-release.json` and release-specific evidence file must not be committed there.

## Top-level contract

The evidence format is:

```text
threadproof-production-deployment/v1
```

and requires `result: "pass"`, `environment: "production"` and `networkType: "persistent-consortium"`. The record binds:

- release version;
- exact tested canonical `develop` SHA;
- observation timestamp;
- production network name;
- chain ID `2026`;
- exact genesis hash;
- exact validator count from the release manifest;
- production signer mode;
- deployed ThreadProof contract addresses/runtime code hashes;
- CapacitySpend and CapacityRelease verifier addresses, runtime code hashes and provenance commitments;
- the required long-running operational service set.

`observedAt` and final signoff must not occur after `release.preparedAt`.

## Validator topology

The artifact contains one record per validator. The number of records must equal the release manifest's validator count and must be at least five. Each validator uses non-secret identifiers and must have unique:

- `validatorId`;
- organization ID;
- validator EVM address;
- Besu node public identifier;
- declared `administrativeDomain`.

Every validator must attest persistent storage, private networking, TLS, node permissioning and monitoring, plus an HTTPS evidence reference and SHA-256.

The verifier requires at least five distinct declared administrative domains. This is a **consistency check over operator declarations**. Cryptography cannot prove that two companies, cloud accounts, legal entities or human administrators are genuinely independent. Consortium governance must still review ownership, account administration and custody evidence.

Do not include host passwords, private hostnames that policy forbids disclosing, private keys, API tokens or other secrets. Use opaque administration-domain identifiers such as `buyer-admin-domain` rather than a person's name or email address.

## Network controls

`networkControls` must record all of the following as true:

- private networking;
- TLS required;
- node permissioning;
- account permissioning;
- persistent storage;
- monitoring;
- backups configured.

The section also commits the sanitized operator/network-control transcript by HTTPS URL and SHA-256. The production deployment itself remains responsible for enforcing those controls; this JSON cannot create them.

## Signer custody

The signing section must use:

```text
mode: remote-web3signer
kmsOrHsmBacked: true
web3SignerTls: true
localPrivateKeysDisabled: true
```

The evidence contains only a non-secret custody description and an immutable transcript commitment. Do not put private keys, mnemonics, seed phrases, credentials, bearer tokens, KMS secrets or Web3Signer endpoint credentials in the repository.

The verifier confirms that signer mode and KMS/HSM policy match the production release manifest. It does not claim to remotely attest the hardware itself.

## Contract and verifier binding

The deployment record must contain exactly these state contracts:

- `Registry`;
- `CredentialRegistry`;
- `OrderRegistry`;
- `CapacityVault`;
- `SubcontractGovernor`;
- `ThreadProofCharter`.

For each contract, address and runtime code hash must equal the production release manifest.

The record also binds the `capacitySpend` and `capacityRelease` verifier deployments. For each verifier it requires equality with the release manifest for:

- verifier address;
- runtime code hash;
- circuit artifact hash;
- verification-key hash;
- source/dependency build-attestation SHA-256 commitment;
- production ceremony-evidence SHA-256 commitment.

This complements the existing live production-deployment verification tools. The sanitized artifact is not a substitute for querying the production RPC and verifying live bytecode before registration.

## Required services

The exact operational service set is:

- `event_indexer`;
- `order_relayer`;
- `subcontract_relayer`;
- `capacity_spend_proof_generator`;
- `capacity_spend_submitter`;
- `capacity_release_proof_generator`;
- `capacity_release_submitter`.

Each service must report `status: "healthy"`, chain ID `2026`, a heartbeat no more than 15 minutes old at `observedAt`, and an immutable sanitized health-evidence reference.

The event indexer must additionally record its canonical cursor and observed head, a positive confirmation depth and `reorgQuarantineEnabled: true`. The cursor may lag the head, but it cannot be ahead of the observed canonical head.

A passing service record is an operator-health attestation. It does not make the off-chain worker authoritative. Capacity, order, credential, subcontract and governance transitions remain canonical only when accepted by the blockchain/contracts and their cryptographic authorization rules.

## Signoff

The artifact records an opaque execution/operator identifier and at least two distinct reviewer identifiers. With only two reviewers, the executor cannot be one of them; this prevents a one-person evidence record from satisfying the minimum review shape by listing themselves twice. `approvedAt` must follow `observedAt` and precede release preparation.

This is not represented as Charter governance unless an actual Charter proposal/action provides that authority. It is release-operations review evidence.

## Secret and privacy boundary

The validator recursively rejects obvious secret-bearing key names such as password, private-key, mnemonic, seed phrase, access token, API key and client secret. It also rejects common private-key/credential text patterns and all `REPLACE_ME`/placeholder material.

The production example at `release/production-deployment-evidence.example.json` deliberately contains placeholders and is regression-tested to remain non-runnable. Never "fix" that example by inserting real production secrets.

Large logs, cloud audit records, monitoring exports, topology reports and signer/KMS records should stay in consortium-approved evidence storage. The committed deployment JSON contains only the minimum sanitized identifiers, booleans and cryptographic commitments needed for release verification.

## Relationship to UAT and recovery evidence

Deployment evidence answers: **what persistent production environment and runtime was reviewed?**

UAT evidence answers: **which functional/adversarial behaviors were exercised on the release-bound production environment?**

Recovery evidence answers: **can chain-derived projections and encrypted private material be restored consistently?**

All three are release evidence. None can override canonical chain state, ZK verification, signatures, credential status or Charter governance, and none crosses the ThreadProof Oracle Boundary into proof of physical manufacturing truth.
