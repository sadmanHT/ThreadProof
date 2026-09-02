#!/usr/bin/env node

import {
  assertProductionEvidenceCaptureSafe,
  buildProductionEvidenceCapture,
  REQUIRED_CONTRACT_NAMES,
  REQUIRED_WORKER_TYPES,
} from "./production-evidence-capture.mjs";

const SOURCE = "1234567890abcdef1234567890abcdef12345678";
const OBSERVED_AT = "2026-09-03T00:10:00.000Z";
const hash = (byte) => `0x${byte.repeat(64)}`;
const address = (byte) => `0x${byte.repeat(40)}`;

const CONTRACT_ADDRESSES = new Map(REQUIRED_CONTRACT_NAMES.map((name, index) => [name, address((index + 1).toString(16))]));
const CONTRACT_HASHES = new Map(REQUIRED_CONTRACT_NAMES.map((name, index) => [name, hash((index + 1).toString(16))]));

const spend = {
  address: address("a"),
  runtimeCodeHash: hash("a"),
  circuitArtifactHash: hash("b"),
  verificationKeyHash: hash("c"),
  buildAttestationSha256: hash("d"),
  ceremonyEvidenceSha256: hash("e"),
};
const release = {
  address: address("b"),
  runtimeCodeHash: hash("1"),
  circuitArtifactHash: hash("2"),
  verificationKeyHash: hash("3"),
  buildAttestationSha256: hash("4"),
  ceremonyEvidenceSha256: hash("5"),
};

function manifest() {
  return {
    schemaVersion: 1,
    release: {
      version: "v1.0.0",
      sourceDevelopCommit: SOURCE,
      preparedAt: "2026-09-03T00:30:00.000Z",
      preparedBy: "release-operator",
    },
    chain: {
      networkName: "ThreadProof Production Consortium",
      chainId: 2026,
      genesisHash: hash("9"),
      validatorCount: 5,
    },
    contracts: REQUIRED_CONTRACT_NAMES.map((name) => ({
      name,
      address: CONTRACT_ADDRESSES.get(name),
      runtimeCodeHash: CONTRACT_HASHES.get(name),
    })),
    verifiers: {
      capacitySpend: { circuitVersion: 1, ...spend },
      capacityRelease: { circuitVersion: 1, ...release },
    },
  };
}

function verifierObservation(circuitVersion, item) {
  return {
    circuitVersion,
    ...item,
    vaultProvenance: {
      verifier: item.address,
      circuitArtifactHash: item.circuitArtifactHash,
      verificationKeyHash: item.verificationKeyHash,
      verifierCodeHash: item.runtimeCodeHash,
    },
  };
}

function chainObservation() {
  return {
    chainId: 2026,
    genesisHash: hash("9"),
    latestBlockNumber: 500,
    latestBlockHash: hash("8"),
    contracts: REQUIRED_CONTRACT_NAMES.map((name) => ({
      name,
      address: CONTRACT_ADDRESSES.get(name),
      runtimeCodeHash: CONTRACT_HASHES.get(name),
    })),
    verifiers: {
      capacitySpend: verifierObservation(1, spend),
      capacityRelease: verifierObservation(1, release),
    },
  };
}

function operationsObservation() {
  return {
    workerHeartbeats: REQUIRED_WORKER_TYPES.map((worker_type, index) => ({
      worker_type,
      status: "ready",
      chain_id: 2026,
      build_commit: SOURCE,
      started_at: `2026-09-03T00:0${Math.min(index, 8)}:00.000Z`,
      last_heartbeat_at: "2026-09-03T00:09:30.000Z",
      last_success_at: "2026-09-03T00:09:20.000Z",
      error_code: null,
    })),
    indexerCursor: {
      chain_id: 2026,
      last_block_number: 497,
      last_block_hash: hash("7"),
      status: "healthy",
      error_code: null,
      updated_at: "2026-09-03T00:09:40.000Z",
      canonical_block_hash: hash("7"),
      configured_confirmation_depth: 2,
      observed_head_distance: 3,
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function expectFailure(name, mutate, expectedText, includeOperations = true) {
  const m = manifest();
  const chain = chainObservation();
  const operations = includeOperations ? operationsObservation() : null;
  mutate({ manifest: m, chain, operations });
  let error;
  try {
    buildProductionEvidenceCapture({ manifest: m, chainObservation: chain, operationsObservation: operations, observedAt: OBSERVED_AT });
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${name}: expected capture to fail`);
  if (!String(error.message).includes(expectedText)) {
    throw new Error(`${name}: expected error containing ${JSON.stringify(expectedText)}, got ${JSON.stringify(error.message)}`);
  }
}

const chainOnly = buildProductionEvidenceCapture({
  manifest: manifest(),
  chainObservation: chainObservation(),
  observedAt: OBSERVED_AT,
});
if (chainOnly.result !== "incomplete" || chainOnly.completion !== "operator-review-required") {
  throw new Error("chain-only capture must remain explicitly incomplete");
}
if (chainOnly.operations.included !== false) throw new Error("chain-only capture must record that operational evidence was not requested");
if (!assertProductionEvidenceCaptureSafe(chainOnly)) throw new Error("chain-only capture safety assertion failed");

const completeObservation = buildProductionEvidenceCapture({
  manifest: manifest(),
  chainObservation: chainObservation(),
  operationsObservation: operationsObservation(),
  observedAt: OBSERVED_AT,
});
if (completeObservation.operations.included !== true) throw new Error("operational capture was not included");
if (completeObservation.operations.workerHeartbeats.length !== REQUIRED_WORKER_TYPES.length) {
  throw new Error("operational capture did not preserve the exact required worker set");
}
if (completeObservation.verifiers.capacitySpend.capacityVaultProvenanceVerified !== true) {
  throw new Error("spend verifier provenance was not marked verified");
}
if (!completeObservation.operatorReviewRequired.includes("remote-web3signer-kms-or-hsm-custody")) {
  throw new Error("capture must keep signer custody in the operator-review boundary");
}
if (!assertProductionEvidenceCaptureSafe(completeObservation)) throw new Error("complete observation safety assertion failed");

expectFailure("wrong chain", ({ chain }) => { chain.chainId = 1; }, "wrong chain ID", false);
expectFailure("wrong genesis", ({ chain }) => { chain.genesisHash = hash("6"); }, "genesis hash does not match", false);
expectFailure("missing contract code hash", ({ chain }) => { chain.contracts[0].runtimeCodeHash = "0x"; }, "non-zero bytes32 hash", false);
expectFailure("wrong contract address", ({ chain }) => { chain.contracts[0].address = address("f"); }, "observed address does not match", false);
expectFailure("unexpected contract", ({ chain }) => { chain.contracts[0].name = "UnexpectedRegistry"; }, "unexpected contract", false);
expectFailure("duplicate manifest contract", ({ manifest: m }) => { m.contracts[1].name = m.contracts[0].name; }, "duplicates contract", false);

expectFailure("verifier circuit provenance mismatch", ({ chain }) => {
  chain.verifiers.capacitySpend.vaultProvenance.circuitArtifactHash = hash("6");
}, "circuit provenance does not match", false);
expectFailure("verifier code provenance mismatch", ({ chain }) => {
  chain.verifiers.capacityRelease.vaultProvenance.verifierCodeHash = hash("6");
}, "verifier-code provenance does not match", false);
expectFailure("verifier wrapper commitment mismatch", ({ chain }) => {
  chain.verifiers.capacitySpend.buildAttestationSha256 = hash("6");
}, "observed buildAttestationSha256 does not match", false);
expectFailure("verifier address mismatch", ({ chain }) => {
  chain.verifiers.capacityRelease.address = address("c");
}, "verifier address does not match", false);

expectFailure("stale heartbeat", ({ operations }) => {
  operations.workerHeartbeats[0].last_heartbeat_at = "2026-09-02T23:30:00.000Z";
}, "heartbeat is stale");
expectFailure("wrong-chain heartbeat", ({ operations }) => {
  operations.workerHeartbeats[1].chain_id = 1;
}, "heartbeat is bound to the wrong chain");
expectFailure("wrong build commit", ({ operations }) => {
  operations.workerHeartbeats[2].build_commit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
}, "heartbeat build commit does not match release source");
expectFailure("worker error", ({ operations }) => {
  operations.workerHeartbeats[3].status = "degraded";
}, "heartbeat is not ready");
expectFailure("unexpected worker field", ({ operations }) => {
  operations.workerHeartbeats[4].error_detail = "private detail must never be captured";
}, "contains unexpected field error_detail");
expectFailure("duplicate worker type", ({ operations }) => {
  operations.workerHeartbeats[6].worker_type = operations.workerHeartbeats[0].worker_type;
}, "duplicate worker heartbeat type");

expectFailure("reorg cursor", ({ operations }) => {
  operations.indexerCursor.status = "reorg_detected";
  operations.indexerCursor.error_code = "REORG";
}, "quarantined or unhealthy");
expectFailure("cursor canonical mismatch", ({ operations }) => {
  operations.indexerCursor.canonical_block_hash = hash("6");
}, "does not match canonical RPC block hash");
expectFailure("insufficient confirmations", ({ operations }) => {
  operations.indexerCursor.observed_head_distance = 1;
}, "has not reached the configured confirmation depth");
expectFailure("unexpected cursor private field", ({ operations }) => {
  operations.indexerCursor.error_detail = "must never leave Supabase";
}, "contains unexpected field error_detail");

const secretArtifact = clone(completeObservation);
secretArtifact.metadata = { apiKey: "do-not-export-this-value" };
let secretRejected = false;
try {
  assertProductionEvidenceCaptureSafe(secretArtifact);
} catch (error) {
  secretRejected = String(error.message).includes("secret-bearing field name");
}
if (!secretRejected) throw new Error("secret-bearing output field was not rejected");

const credentialUrlArtifact = clone(completeObservation);
credentialUrlArtifact.metadata = { source: "https://operator:credential@example.invalid/evidence" };
let credentialUrlRejected = false;
try {
  assertProductionEvidenceCaptureSafe(credentialUrlArtifact);
} catch (error) {
  credentialUrlRejected = String(error.message).includes("credential-bearing URL");
}
if (!credentialUrlRejected) throw new Error("credential-bearing URL was not rejected");

for (const forbiddenField of ["signing", "validators", "signoff", "reviewers"]) {
  const unsafe = clone(completeObservation);
  unsafe[forbiddenField] = {};
  let rejected = false;
  try {
    assertProductionEvidenceCaptureSafe(unsafe);
  } catch (error) {
    rejected = String(error.message).includes("reserved for independent operator/consortium evidence");
  }
  if (!rejected) throw new Error(`${forbiddenField} must remain outside the capture artifact`);
}

const promoted = clone(completeObservation);
promoted.result = "pass";
let promotionRejected = false;
try {
  assertProductionEvidenceCaptureSafe(promoted);
} catch (error) {
  promotionRejected = String(error.message).includes("must remain explicitly incomplete");
}
if (!promotionRejected) throw new Error("capture artifact must never be promotable to result=pass by metadata editing");

console.log("Production evidence capture policy and adversarial regressions passed");
