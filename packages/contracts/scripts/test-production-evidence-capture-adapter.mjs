#!/usr/bin/env node

import { keccak256 } from "ethers";
import {
  captureChainObservation,
  captureOperationsObservation,
  captureProductionEvidence,
  CURSOR_SELECT,
  WORKER_SELECT,
} from "./capture-production-evidence.mjs";
import { REQUIRED_CONTRACT_NAMES, REQUIRED_WORKER_TYPES } from "../../../scripts/production-evidence-capture.mjs";

const SOURCE = "1234567890abcdef1234567890abcdef12345678";
const OBSERVED_AT = "2026-09-03T00:10:00.000Z";
const hash = (digit) => `0x${digit.repeat(64)}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const stateCode = "0x60016000";
const spendCode = "0x60026000";
const releaseCode = "0x60036000";
const stateRuntimeHash = keccak256(stateCode).toLowerCase();
const spendRuntimeHash = keccak256(spendCode).toLowerCase();
const releaseRuntimeHash = keccak256(releaseCode).toLowerCase();
const CONTRACT_ADDRESSES = new Map(REQUIRED_CONTRACT_NAMES.map((name, index) => [name, address((index + 1).toString(16))]));
const SPEND_ADDRESS = address("a");
const RELEASE_ADDRESS = address("b");

const spendCommitments = {
  circuitArtifactHash: hash("b"),
  verificationKeyHash: hash("c"),
  buildAttestationSha256: hash("d"),
  ceremonyEvidenceSha256: hash("e"),
};
const releaseCommitments = {
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
      runtimeCodeHash: stateRuntimeHash,
    })),
    verifiers: {
      capacitySpend: {
        circuitVersion: 1,
        address: SPEND_ADDRESS,
        runtimeCodeHash: spendRuntimeHash,
        ...spendCommitments,
      },
      capacityRelease: {
        circuitVersion: 1,
        address: RELEASE_ADDRESS,
        runtimeCodeHash: releaseRuntimeHash,
        ...releaseCommitments,
      },
    },
  };
}

function makeRpc(overrides = {}) {
  return {
    async getChainId() {
      return overrides.chainId ?? 2026;
    },
    async getBlock(tag) {
      if (tag === 0) return { number: 0, hash: hash("9") };
      if (tag === "latest") return { number: 500, hash: hash("8") };
      if (tag === 497) return { number: 497, hash: hash("7") };
      throw new Error(`unexpected block tag ${tag}`);
    },
    async getCode(contractAddress) {
      if (overrides.emptyCodeAddress?.toLowerCase() === contractAddress.toLowerCase()) return "0x";
      if (contractAddress.toLowerCase() === SPEND_ADDRESS.toLowerCase()) return spendCode;
      if (contractAddress.toLowerCase() === RELEASE_ADDRESS.toLowerCase()) return releaseCode;
      return stateCode;
    },
    async readVerifier(verifierAddress) {
      if (verifierAddress.toLowerCase() === SPEND_ADDRESS.toLowerCase()) return spendCommitments;
      if (verifierAddress.toLowerCase() === RELEASE_ADDRESS.toLowerCase()) return releaseCommitments;
      throw new Error("unexpected verifier address");
    },
    async readCapacityVaultProvenance(_vaultAddress, _version, kind) {
      const target = kind === "capacitySpend"
        ? { address: SPEND_ADDRESS, runtimeCodeHash: spendRuntimeHash, ...spendCommitments }
        : { address: RELEASE_ADDRESS, runtimeCodeHash: releaseRuntimeHash, ...releaseCommitments };
      return {
        verifier: target.address,
        circuitArtifactHash: target.circuitArtifactHash,
        verificationKeyHash: target.verificationKeyHash,
        verifierCodeHash: overrides.provenanceCodeHash ?? target.runtimeCodeHash,
      };
    },
  };
}

function heartbeatRows() {
  const rows = REQUIRED_WORKER_TYPES.map((worker_type, index) => ({
    worker_type,
    status: "ready",
    chain_id: 2026,
    build_commit: SOURCE,
    started_at: `2026-09-03T00:0${Math.min(index, 8)}:00.000Z`,
    last_heartbeat_at: "2026-09-03T00:09:30.000Z",
    last_success_at: "2026-09-03T00:09:20.000Z",
    error_code: null,
  }));
  rows.push({ ...rows[0], last_heartbeat_at: "2026-09-03T00:01:00.000Z", last_success_at: "2026-09-03T00:01:00.000Z" });
  return rows;
}

function cursorRows() {
  return [{
    chain_id: 2026,
    last_block_number: 497,
    last_block_hash: hash("7"),
    status: "healthy",
    error_code: null,
    updated_at: "2026-09-03T00:09:40.000Z",
  }];
}

function makeFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({
      pathname: parsed.pathname,
      select: parsed.searchParams.get("select"),
      order: parsed.searchParams.get("order"),
      chain: parsed.searchParams.get("chain_id"),
      authorizationPresent: typeof options?.headers?.Authorization === "string",
      apiKeyPresent: typeof options?.headers?.apikey === "string",
    });
    const body = parsed.pathname.endsWith("/worker_runtime_heartbeats") ? heartbeatRows() : cursorRows();
    return {
      ok: true,
      status: 200,
      async json() { return body; },
    };
  };
  return { fetchImpl, calls };
}

async function expectFailure(name, operation, expectedText) {
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${name}: expected failure`);
  if (!String(error.message).includes(expectedText)) {
    throw new Error(`${name}: expected ${JSON.stringify(expectedText)}, got ${JSON.stringify(error.message)}`);
  }
}

const chain = await captureChainObservation(manifest(), makeRpc());
if (chain.chainId !== 2026 || chain.genesisHash !== hash("9") || chain.latestBlockNumber !== 500) {
  throw new Error("chain capture did not preserve the canonical RPC observation");
}
if (chain.contracts.length !== REQUIRED_CONTRACT_NAMES.length || chain.contracts.some((entry) => entry.runtimeCodeHash !== stateRuntimeHash)) {
  throw new Error("state-contract runtime code hashes were not captured deterministically");
}
if (chain.verifiers.capacitySpend.runtimeCodeHash !== spendRuntimeHash || chain.verifiers.capacityRelease.runtimeCodeHash !== releaseRuntimeHash) {
  throw new Error("verifier runtime code hashes were not captured deterministically");
}

const { fetchImpl, calls } = makeFetch();
const serviceRoleKey = "service-role-test-value-never-export";
const operations = await captureOperationsObservation({
  fetchImpl,
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey,
  rpc: makeRpc(),
  latestBlockNumber: 500,
  confirmationDepth: 2,
});
if (operations.workerHeartbeats.length !== REQUIRED_WORKER_TYPES.length) {
  throw new Error("adapter did not collapse worker telemetry to exactly one latest row per required worker type");
}
if (operations.workerHeartbeats[0].last_heartbeat_at !== "2026-09-03T00:09:30.000Z") {
  throw new Error("adapter did not select the latest heartbeat row");
}
if (operations.indexerCursor.canonical_block_hash !== hash("7") || operations.indexerCursor.observed_head_distance !== 3) {
  throw new Error("adapter did not bind the cursor to the canonical RPC block and observed head distance");
}
if (calls.length !== 2) throw new Error(`adapter must make exactly two sanitized Supabase reads, got ${calls.length}`);
const workerCall = calls.find((call) => call.pathname.endsWith("/worker_runtime_heartbeats"));
const cursorCall = calls.find((call) => call.pathname.endsWith("/chain_indexer_cursors"));
if (!workerCall || workerCall.select !== WORKER_SELECT || workerCall.order !== "worker_type.asc,last_heartbeat_at.desc") {
  throw new Error("worker heartbeat REST query drifted from the exact sanitized projection");
}
if (!cursorCall || cursorCall.select !== CURSOR_SELECT || cursorCall.chain !== "eq.2026") {
  throw new Error("indexer cursor REST query drifted from the exact sanitized chain-2026 projection");
}
for (const call of calls) {
  if (!call.authorizationPresent || !call.apiKeyPresent) throw new Error("Supabase operational read did not use server-side authorization headers");
  if (call.select.includes("error_detail") || call.select.includes("*") || call.select.includes("private")) {
    throw new Error("Supabase capture query requests a forbidden or over-broad field");
  }
}

const fullFetch = makeFetch();
const artifact = await captureProductionEvidence({
  manifest: manifest(),
  rpc: makeRpc(),
  includeSupabase: true,
  fetchImpl: fullFetch.fetchImpl,
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey,
  confirmationDepth: 2,
  observedAt: OBSERVED_AT,
});
const serialized = JSON.stringify(artifact);
if (artifact.result !== "incomplete" || artifact.completion !== "operator-review-required") {
  throw new Error("live adapter must never emit final production pass evidence");
}
if (serialized.includes(serviceRoleKey) || serialized.includes("example.supabase.co")) {
  throw new Error("live adapter leaked an operational credential or Supabase endpoint into the capture artifact");
}
if ("signing" in artifact || "validators" in artifact || "signoff" in artifact) {
  throw new Error("live adapter crossed into operator/consortium assertion fields");
}

await expectFailure("wrong chain id", () => captureChainObservation(manifest(), makeRpc({ chainId: 1 })), "expected 2026");
await expectFailure(
  "missing deployed code",
  () => captureChainObservation(manifest(), makeRpc({ emptyCodeAddress: CONTRACT_ADDRESSES.get("Registry") })),
  "has no deployed runtime bytecode",
);
await expectFailure(
  "verifier provenance code mismatch",
  () => captureProductionEvidence({ manifest: manifest(), rpc: makeRpc({ provenanceCodeHash: hash("6") }), observedAt: OBSERVED_AT }),
  "verifier-code provenance does not match live bytecode",
);
await expectFailure(
  "credential-bearing Supabase URL",
  () => captureOperationsObservation({
    fetchImpl: makeFetch().fetchImpl,
    supabaseUrl: "https://operator:credential@example.supabase.co",
    serviceRoleKey,
    rpc: makeRpc(),
    latestBlockNumber: 500,
    confirmationDepth: 2,
  }),
  "must not contain embedded credentials",
);
await expectFailure(
  "non-TLS Supabase URL",
  () => captureOperationsObservation({
    fetchImpl: makeFetch().fetchImpl,
    supabaseUrl: "http://example.supabase.co",
    serviceRoleKey,
    rpc: makeRpc(),
    latestBlockNumber: 500,
    confirmationDepth: 2,
  }),
  "must use HTTPS",
);

console.log("Production evidence capture live-adapter offline regressions passed");
