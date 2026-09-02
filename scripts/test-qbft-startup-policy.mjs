import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  THREADPROOF_BASELINE_VALIDATOR_COUNT,
  THREADPROOF_HEALTHY_PEER_MINIMUM,
  THREADPROOF_SYNC_MIN_PEERS,
  THREADPROOF_TOLERATED_UNAVAILABLE_VALIDATORS,
  parseBesuSyncMinPeers,
  validateQbftStartupPeerPolicy,
  validateThreadProofBaselinePeerPolicy,
} from "./qbft-network-policy.mjs";

const pilotConfig = readFileSync(new URL("../infrastructure/besu/pilot/besu-config.toml", import.meta.url), "utf8");
const productionConfig = readFileSync(new URL("../infrastructure/besu/production/besu-config.toml", import.meta.url), "utf8");
const productionTopology = JSON.parse(
  readFileSync(new URL("../infrastructure/besu/production/consortium-topology.example.json", import.meta.url), "utf8"),
);
const pilotRuntime = readFileSync(new URL("./pilot-chain.mjs", import.meta.url), "utf8");

assert.equal(THREADPROOF_BASELINE_VALIDATOR_COUNT, 5);
assert.equal(THREADPROOF_TOLERATED_UNAVAILABLE_VALIDATORS, 1);
assert.equal(THREADPROOF_SYNC_MIN_PEERS, 3);
assert.equal(THREADPROOF_HEALTHY_PEER_MINIMUM, 4);

for (const [label, source] of [
  ["pilot Besu config", pilotConfig],
  ["production Besu config", productionConfig],
]) {
  const configured = parseBesuSyncMinPeers(source, label);
  assert.equal(configured, THREADPROOF_SYNC_MIN_PEERS, `${label} must pin the reviewed startup threshold`);
  const policy = validateThreadProofBaselinePeerPolicy(configured);
  assert.equal(policy.remotePeersWithToleratedUnavailable, 3);
  assert.equal(policy.fullHealthyRemotePeers, 4);
}

assert.equal(
  productionTopology.validators?.length,
  THREADPROOF_BASELINE_VALIDATOR_COUNT,
  "production topology example must model the five-validator ThreadProof baseline",
);

assert.throws(
  () => validateQbftStartupPeerPolicy({
    validatorCount: 5,
    toleratedUnavailableValidators: 1,
    syncMinPeers: 4,
    healthyPeerMinimum: 4,
  }),
  /exceeds the 3 remote validator peers reachable/,
);
assert.throws(
  () => validateThreadProofBaselinePeerPolicy(2),
  /requires sync-min-peers=3/,
);
assert.throws(
  () => parseBesuSyncMinPeers("network-id=2026\n", "missing config"),
  /define sync-min-peers exactly once/,
);
assert.throws(
  () => parseBesuSyncMinPeers("sync-min-peers=3\nsync-min-peers=3\n", "duplicate config"),
  /found 2/,
);

for (const fragment of [
  "waitForHealthyTopology",
  "waitForFirstPostGenesisBlock",
  "RPC_STARTUP_TIMEOUT_MS",
  "BLOCK_PRODUCTION_TIMEOUT_MS",
  "AbortSignal.timeout(8_000)",
  "THREADPROOF_HEALTHY_PEER_MINIMUM",
  "validateThreadProofBaselinePeerPolicy",
]) {
  assert.ok(pilotRuntime.includes(fragment), `pilot readiness must include ${fragment}`);
}

console.log(
  "QBFT startup policy checks passed: five validators, one tolerated unavailable validator, sync-min-peers=3, healthy readiness=4 peers.",
);
