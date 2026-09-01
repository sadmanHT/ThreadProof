import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import {
  ConsortiumTopologyError,
  decodeQbftGenesisValidators,
  parsePermissionNodes,
  validateConsortiumTopology,
  validatorAddressFromNodeId,
} from "./validate-consortium-topology.mjs";

function deterministicValidator(seed, name) {
  const privateKey = Buffer.alloc(32);
  privateKey[31] = seed;
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(privateKey);
  const nodeId = ecdh.getPublicKey(undefined, "uncompressed").subarray(1).toString("hex");
  return {
    name,
    nodeId,
    address: validatorAddressFromNodeId(nodeId),
    enode: `enode://${nodeId}@${name}.internal:30303`,
  };
}

function rlpLength(length, offset) {
  if (length < 56) return Buffer.from([offset + length]);
  const hex = length.toString(16).padStart(2, "0");
  const lengthBytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  return Buffer.concat([Buffer.from([offset + 55 + lengthBytes.length]), lengthBytes]);
}

function rlpBytes(value) {
  const bytes = Buffer.from(value);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return Buffer.concat([rlpLength(bytes.length, 0x80), bytes]);
}

function rlpList(items) {
  const payload = Buffer.concat(items);
  return Buffer.concat([rlpLength(payload.length, 0xc0), payload]);
}

function qbftExtraData(addresses, { modernNoVote = false, vote = null } = {}) {
  const validatorList = rlpList(addresses.map((address) => rlpBytes(Buffer.from(address.slice(2), "hex"))));
  const voteItem = vote
    ? rlpBytes(vote)
    : modernNoVote
      ? rlpList([])
      : rlpBytes(Buffer.alloc(0));
  return `0x${rlpList([
    rlpBytes(Buffer.alloc(32)),
    validatorList,
    voteItem,
    rlpBytes(Buffer.alloc(0)),
    rlpList([]),
  ]).toString("hex")}`;
}

const validators = [
  deterministicValidator(1, "validator-a"),
  deterministicValidator(2, "validator-b"),
  deterministicValidator(3, "validator-c"),
  deterministicValidator(4, "validator-d"),
].map(({ name, enode, address }) => ({ name, enode, address }));

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
  extraData: qbftExtraData(validators.map((validator) => validator.address)),
  gasLimit: "0x1fffffffffffff",
  difficulty: "0x1",
  mixHash: `0x${"00".repeat(32)}`,
  coinbase: "0x0000000000000000000000000000000000000000",
  alloc: {},
};
const genesisText = `${JSON.stringify(genesis, null, 2)}\n`;
const genesisSha256 = createHash("sha256").update(genesisText, "utf8").digest("hex");
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
assert.deepEqual(
  decodeQbftGenesisValidators(genesis.extraData).sort(),
  validators.map((validator) => validator.address).sort(),
);

// Besu 26.x emits the canonical QBFT "No Vote" field as an empty RLP list.
const modernBesuExtraData = qbftExtraData(validators.map((validator) => validator.address), { modernNoVote: true });
assert.deepEqual(
  decodeQbftGenesisValidators(modernBesuExtraData).sort(),
  validators.map((validator) => validator.address).sort(),
);
rejects(/must not contain an initial validator vote/, () => decodeQbftGenesisValidators(
  qbftExtraData(validators.map((validator) => validator.address), { vote: Buffer.from([1]) }),
));

assert.deepEqual(parsePermissionNodes('nodes-allowlist=["enode://x"]\n'), ["enode://x"]);
rejects(/JSON-compatible TOML string array/, () => parsePermissionNodes("nodes-allowlist=['enode://x']\n"));

rejects(/at least 4 validators/, () => validate({
  topology: { ...topology, validators: validators.slice(0, 3) },
  staticNodes: validators.slice(1, 3).map((validator) => validator.enode),
  permissionsSource: `nodes-allowlist=${JSON.stringify(validators.slice(1, 3).map((validator) => validator.enode))}\n`,
}));

rejects(/address does not match its enode public key/, () => validate({
  topology: {
    ...topology,
    validators: validators.map((validator, index) => index === 3
      ? { ...validator, address: validators[2].address }
      : validator),
  },
}));

const replacement = deterministicValidator(5, "validator-e");
rejects(/do not exactly match the QBFT genesis/, () => validate({
  topology: {
    ...topology,
    validators: [...validators.slice(0, 3), {
      name: replacement.name,
      enode: replacement.enode,
      address: replacement.address,
    }],
    localNode: "validator-a",
  },
  staticNodes: [validators[1].enode, validators[2].enode, replacement.enode],
  permissionsSource: `nodes-allowlist=${JSON.stringify([validators[1].enode, validators[2].enode, replacement.enode])}\n`,
}));

rejects(/Remote validator validator-d must be a static peer/, () => validate({
  staticNodes: staticNodes.slice(0, 2),
}));

rejects(/absent from the Besu nodes-allowlist/, () => validate({
  permissionsSource: `nodes-allowlist=${JSON.stringify(staticNodes.slice(0, 2))}\n`,
}));

const observer = deterministicValidator(6, "observer-a");
rejects(/not approved by the topology manifest/, () => validate({
  staticNodes: [...staticNodes, observer.enode],
  permissionsSource: `nodes-allowlist=${JSON.stringify([...staticNodes, observer.enode])}\n`,
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

rejects(/RLP\(\[vanity, validators, vote, round, seals\]\)/, () => validate({
  genesis: { ...genesis, extraData: `0x${"00".repeat(33)}` },
}));

console.log("ThreadProof consortium topology preflight checks passed");
