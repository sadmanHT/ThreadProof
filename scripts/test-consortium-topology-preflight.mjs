import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ConsortiumTopologyError,
  parsePermissionNodes,
  validateConsortiumTopology,
} from "./validate-consortium-topology.mjs";

const nodeId = (hex) => hex.repeat(128);
const enode = (hex, host) => `enode://${nodeId(hex)}@${host}:30303`;

const genesis = {
  config: {
    chainId: 2026,
    qbft: {
      blockperiodseconds: 2,
      epochlength: 30000,
      requesttimeoutseconds: 4,
    },
  },
  nonce: "0x0",
  timestamp: "0x0",
  extraData: `0x${"00".repeat(33)}`,
  gasLimit: "0x1fffffffffffff",
  difficulty: "0x1",
  mixHash: `0x${"00".repeat(32)}`,
  coinbase: "0x0000000000000000000000000000000000000000",
  alloc: {},
};
const genesisText = `${JSON.stringify(genesis, null, 2)}\n`;
const genesisSha256 = createHash("sha256").update(genesisText, "utf8").digest("hex");

const validators = [
  { name: "validator-a", enode: enode("a", "validator-a.internal") },
  { name: "validator-b", enode: enode("b", "validator-b.internal") },
  { name: "validator-c", enode: enode("c", "validator-c.internal") },
  { name: "validator-d", enode: enode("d", "validator-d.internal") },
];
const staticNodes = validators.slice(1).map((validator) => validator.enode);
const permissionsSource = `nodes-allowlist=${JSON.stringify(staticNodes)}\naccounts-allowlist=[]\n`;
const topology = {
  chainId: 2026,
  consensus: "qbft",
  genesisSha256,
  localNode: "validator-a",
  validators,
  observers: [],
};

function validate(overrides = {}) {
  return validateConsortiumTopology({
    topology: overrides.topology ?? topology,
    genesis: overrides.genesis ?? genesis,
    genesisText: overrides.genesisText ?? genesisText,
    staticNodes: overrides.staticNodes ?? staticNodes,
    permissionsSource: overrides.permissionsSource ?? permissionsSource,
    expectedChainId: overrides.expectedChainId ?? 2026,
  });
}

function rejects(pattern, task) {
  assert.throws(task, (error) => {
    assert.ok(error instanceof ConsortiumTopologyError);
    assert.match(error.message, pattern);
    return true;
  });
}

const valid = validate();
assert.equal(valid.validatorCount, 4);
assert.equal(valid.toleratedFaults, 1);
assert.equal(valid.staticPeerCount, 3);
assert.equal(valid.localNode, "validator-a");
assert.equal(valid.localRole, "validator");

assert.deepEqual(parsePermissionNodes('nodes-allowlist=["enode://x"]\n'), ["enode://x"]);
rejects(/JSON-compatible TOML string array/, () => parsePermissionNodes("nodes-allowlist=['enode://x']\n"));

rejects(/at least 4 validators/, () => validate({
  topology: { ...topology, validators: validators.slice(0, 3) },
  staticNodes: validators.slice(1, 3).map((validator) => validator.enode),
  permissionsSource: `nodes-allowlist=${JSON.stringify(validators.slice(1, 3).map((validator) => validator.enode))}\n`,
}));

rejects(/node public ids.*unique/i, () => validate({
  topology: {
    ...topology,
    validators: [...validators.slice(0, 3), { name: "validator-d", enode: enode("c", "validator-d.internal") }],
  },
}));

rejects(/Remote validator validator-d must be a static peer/, () => validate({
  staticNodes: staticNodes.slice(0, 2),
}));

rejects(/absent from the Besu nodes-allowlist/, () => validate({
  permissionsSource: `nodes-allowlist=${JSON.stringify(staticNodes.slice(0, 2))}\n`,
}));

const unknown = enode("e", "unknown.internal");
rejects(/not approved by the topology manifest/, () => validate({
  staticNodes: [...staticNodes, unknown],
  permissionsSource: `nodes-allowlist=${JSON.stringify([...staticNodes, unknown])}\n`,
}));

rejects(/Genesis SHA-256 .* does not match/, () => validate({
  genesisText: `${genesisText} `,
}));

rejects(/Genesis chain ID 2027/, () => validate({
  genesis: { ...genesis, config: { ...genesis.config, chainId: 2027 } },
}));

rejects(/genesis.config.qbft must be an object/, () => validate({
  genesis: { ...genesis, config: { chainId: 2026 } },
}));

rejects(/Topology chain ID 2027/, () => validate({
  topology: { ...topology, chainId: 2027 },
}));

rejects(/localNode .* is not present/, () => validate({
  topology: { ...topology, localNode: "validator-z" },
}));

console.log("ThreadProof consortium topology preflight checks passed");
