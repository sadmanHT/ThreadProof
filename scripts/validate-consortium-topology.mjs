import { createHash, ECDH } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export class ConsortiumTopologyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsortiumTopologyError";
  }
}

function fail(message) {
  throw new ConsortiumTopologyError(message);
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function asPositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

const MASK_64 = (1n << 64n) - 1n;
const KECCAK_ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotateLeft64(value, shift) {
  const lane = value & MASK_64;
  if (shift === 0) return lane;
  const amount = BigInt(shift);
  return ((lane << amount) | (lane >> (64n - amount))) & MASK_64;
}

function keccakPermutation(state) {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const c = new Array(5).fill(0n);
    const d = new Array(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5] ^ rotateLeft64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
    }

    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const targetX = y;
        const targetY = (2 * x + 3 * y) % 5;
        b[targetX + 5 * targetY] = rotateLeft64(state[x + 5 * y], KECCAK_ROTATION[x + 5 * y]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK_64;
      }
    }
    state[0] = (state[0] ^ roundConstant) & MASK_64;
  }
}

export function keccak256Hex(input) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136;
  const blockCount = Math.ceil((source.length + 1) / rate);
  const padded = Buffer.alloc(blockCount * rate);
  source.copy(padded);
  padded[source.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let laneIndex = 0; laneIndex < rate / 8; laneIndex += 1) {
      let lane = 0n;
      for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
        lane |= BigInt(padded[offset + laneIndex * 8 + byteIndex]) << BigInt(byteIndex * 8);
      }
      state[laneIndex] = (state[laneIndex] ^ lane) & MASK_64;
    }
    keccakPermutation(state);
  }

  const output = Buffer.alloc(32);
  for (let byteIndex = 0; byteIndex < output.length; byteIndex += 1) {
    const lane = state[Math.floor(byteIndex / 8)];
    output[byteIndex] = Number((lane >> BigInt((byteIndex % 8) * 8)) & 0xffn);
  }
  return output.toString("hex");
}

export function validatorAddressFromNodeId(nodeId) {
  if (typeof nodeId !== "string" || !/^[0-9a-fA-F]{128}$/.test(nodeId)) {
    fail("Validator node id must contain exactly 64 public-key bytes");
  }
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(nodeId, "hex")]);
  try {
    ECDH.convertKey(publicKey, "secp256k1", undefined, undefined, "uncompressed");
  } catch {
    fail("Validator enode contains an invalid secp256k1 public key");
  }
  const digest = keccak256Hex(Buffer.from(nodeId, "hex"));
  return `0x${digest.slice(-40)}`;
}

export function parseEnode(value, label = "enode") {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const match = value.match(/^enode:\/\/([0-9a-fA-F]{128})@(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})(?:\?discport=(\d{1,5}))?$/);
  if (!match) {
    fail(`${label} must be an enode URL with a 64-byte public node id, explicit host, and TCP port`);
  }

  const [, nodeIdRaw, hostRaw, portRaw, discoveryPortRaw] = match;
  const port = Number(portRaw);
  if (port < 1 || port > 65_535) fail(`${label} has an invalid TCP port`);
  if (discoveryPortRaw !== undefined) {
    const discoveryPort = Number(discoveryPortRaw);
    if (discoveryPort < 0 || discoveryPort > 65_535) fail(`${label} has an invalid discovery port`);
  }

  const nodeId = nodeIdRaw.toLowerCase();
  validatorAddressFromNodeId(nodeId);
  const host = hostRaw.toLowerCase();
  const discovery = discoveryPortRaw === undefined ? "" : `?discport=${Number(discoveryPortRaw)}`;
  return {
    nodeId,
    canonical: `enode://${nodeId}@${host}:${port}${discovery}`,
  };
}

export function parsePermissionNodes(source) {
  if (typeof source !== "string") fail("Besu permissions config must be text");
  const match = source.match(/(?:^|\n)\s*nodes-allowlist\s*=\s*(\[[\s\S]*?\])\s*(?:\n|$)/);
  if (!match) fail("permissions_config.toml is missing nodes-allowlist");

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    fail("nodes-allowlist must use a JSON-compatible TOML string array for deterministic validation");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    fail("nodes-allowlist must be an array of enode strings");
  }
  return parsed;
}

function parseAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${label} must be a 20-byte hex address`);
  return value.toLowerCase();
}

function parsePeerEntries(entries, role) {
  if (!Array.isArray(entries)) fail(`topology.${role} must be an array`);
  return entries.map((entry, index) => {
    const object = asObject(entry, `topology.${role}[${index}]`);
    if (typeof object.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(object.name)) {
      fail(`topology.${role}[${index}].name must be a stable lowercase DNS-style label`);
    }
    const parsed = parseEnode(object.enode, `topology.${role}[${index}].enode`);
    if (role === "validators") {
      const address = parseAddress(object.address, `topology.${role}[${index}].address`);
      const derivedAddress = validatorAddressFromNodeId(parsed.nodeId);
      if (address !== derivedAddress) {
        fail(`Validator ${object.name} address does not match its enode public key`);
      }
      return { name: object.name, enode: parsed.canonical, nodeId: parsed.nodeId, address, role };
    }
    return { name: object.name, enode: parsed.canonical, nodeId: parsed.nodeId, role };
  });
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique`);
}

function canonicalEnodeSet(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const parsed = values.map((value, index) => parseEnode(value, `${label}[${index}]`).canonical);
  assertUnique(parsed, `${label} entries`);
  return new Set(parsed);
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readRlpLength(buffer, offset, lengthOfLength, label) {
  if (lengthOfLength < 1 || lengthOfLength > 6 || offset + lengthOfLength > buffer.length) fail(`${label} has an invalid RLP length prefix`);
  if (buffer[offset] === 0) fail(`${label} uses a non-canonical RLP length`);
  let length = 0;
  for (let index = 0; index < lengthOfLength; index += 1) length = length * 256 + buffer[offset + index];
  if (!Number.isSafeInteger(length)) fail(`${label} RLP item is too large`);
  return length;
}

function decodeRlpItem(buffer, offset, label) {
  if (offset >= buffer.length) fail(`${label} is truncated`);
  const prefix = buffer[offset];
  if (prefix <= 0x7f) return { value: buffer.subarray(offset, offset + 1), next: offset + 1 };

  if (prefix <= 0xb7) {
    const length = prefix - 0x80;
    const start = offset + 1;
    const end = start + length;
    if (end > buffer.length) fail(`${label} string is truncated`);
    if (length === 1 && buffer[start] < 0x80) fail(`${label} uses non-canonical short-string RLP`);
    return { value: buffer.subarray(start, end), next: end };
  }

  if (prefix <= 0xbf) {
    const lengthOfLength = prefix - 0xb7;
    const lengthStart = offset + 1;
    const length = readRlpLength(buffer, lengthStart, lengthOfLength, label);
    if (length < 56) fail(`${label} uses non-canonical long-string RLP`);
    const start = lengthStart + lengthOfLength;
    const end = start + length;
    if (end > buffer.length) fail(`${label} long string is truncated`);
    return { value: buffer.subarray(start, end), next: end };
  }

  const decodeList = (start, end) => {
    if (end > buffer.length) fail(`${label} list is truncated`);
    const values = [];
    let cursor = start;
    while (cursor < end) {
      const decoded = decodeRlpItem(buffer, cursor, label);
      if (decoded.next > end) fail(`${label} list child exceeds its encoded boundary`);
      values.push(decoded.value);
      cursor = decoded.next;
    }
    if (cursor !== end) fail(`${label} list has an invalid encoded boundary`);
    return values;
  };

  if (prefix <= 0xf7) {
    const length = prefix - 0xc0;
    const start = offset + 1;
    const end = start + length;
    return { value: decodeList(start, end), next: end };
  }

  const lengthOfLength = prefix - 0xf7;
  const lengthStart = offset + 1;
  const length = readRlpLength(buffer, lengthStart, lengthOfLength, label);
  if (length < 56) fail(`${label} uses non-canonical long-list RLP`);
  const start = lengthStart + lengthOfLength;
  const end = start + length;
  return { value: decodeList(start, end), next: end };
}

export function decodeQbftGenesisValidators(extraData) {
  if (typeof extraData !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(extraData)) {
    fail("QBFT genesis extraData must be even-length hex");
  }
  const encoded = Buffer.from(extraData.slice(2), "hex");
  const decoded = decodeRlpItem(encoded, 0, "QBFT genesis extraData");
  if (decoded.next !== encoded.length || !Array.isArray(decoded.value) || decoded.value.length !== 5) {
    fail("QBFT genesis extraData must be RLP([vanity, validators, vote, round, seals])");
  }
  const [vanity, validatorItems, vote, round, seals] = decoded.value;
  if (!Buffer.isBuffer(vanity) || vanity.length !== 32) fail("QBFT genesis vanity data must be exactly 32 bytes");
  if (!Array.isArray(validatorItems)) fail("QBFT genesis validator field must be an RLP list");
  if (!Buffer.isBuffer(vote) || vote.length !== 0) fail("QBFT genesis must not contain an initial validator vote");
  if (!Buffer.isBuffer(round) || round.length !== 0) fail("QBFT genesis round must be zero");
  if (!Array.isArray(seals) || seals.length !== 0) fail("QBFT genesis must not contain validator seals");

  const addresses = validatorItems.map((item, index) => {
    if (!Buffer.isBuffer(item) || item.length !== 20) fail(`QBFT genesis validator ${index} must be a 20-byte address`);
    return `0x${item.toString("hex")}`;
  });
  assertUnique(addresses, "QBFT genesis validator addresses");
  return addresses;
}

export function validateConsortiumTopology({
  topology,
  genesis,
  genesisText,
  staticNodes,
  permissionsSource,
  expectedChainId = 2026,
}) {
  const topologyObject = asObject(topology, "topology");
  const genesisObject = asObject(genesis, "genesis");
  const expected = asPositiveInteger(expectedChainId, "expected chain ID");
  const topologyChainId = asPositiveInteger(topologyObject.chainId, "topology.chainId");
  if (topologyChainId !== expected) {
    fail(`Topology chain ID ${topologyChainId} does not match expected ThreadProof chain ID ${expected}`);
  }
  if (String(topologyObject.consensus).toLowerCase() !== "qbft") fail("Topology consensus must be qbft");

  const genesisConfig = asObject(genesisObject.config, "genesis.config");
  const genesisChainId = asPositiveInteger(genesisConfig.chainId, "genesis.config.chainId");
  if (genesisChainId !== expected) {
    fail(`Genesis chain ID ${genesisChainId} does not match expected ThreadProof chain ID ${expected}`);
  }
  const qbftConfig = asObject(genesisConfig.qbft, "genesis.config.qbft");
  if (Object.keys(qbftConfig).some((key) => key.toLowerCase() === "validatorcontractaddress")) {
    fail("This topology preflight requires QBFT block-header validator selection; contract validator selection needs a separate validator-state proof");
  }
  const genesisValidators = decodeQbftGenesisValidators(genesisObject.extraData);
  if (typeof genesisText !== "string" || genesisText.length === 0) fail("Raw genesis text is required for approval hashing");
  if (typeof topologyObject.genesisSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(topologyObject.genesisSha256)) {
    fail("topology.genesisSha256 must be the approved 32-byte SHA-256 digest without a 0x prefix");
  }
  const actualGenesisHash = sha256Hex(genesisText);
  if (actualGenesisHash !== topologyObject.genesisSha256.toLowerCase()) {
    fail(`Genesis SHA-256 ${actualGenesisHash} does not match the approved topology manifest`);
  }

  const validators = parsePeerEntries(topologyObject.validators, "validators");
  const observers = parsePeerEntries(topologyObject.observers ?? [], "observers");
  if (validators.length < 4) {
    fail(`QBFT production topology requires at least 4 validators for one-fault tolerance; found ${validators.length}`);
  }
  if (genesisValidators.length < 4) {
    fail(`QBFT genesis requires at least 4 validators for one-fault tolerance; found ${genesisValidators.length}`);
  }
  const toleratedFaults = Math.floor((validators.length - 1) / 3);
  if (toleratedFaults < 1) fail("QBFT topology must tolerate at least one validator fault");

  const peers = [...validators, ...observers];
  assertUnique(peers.map((peer) => peer.name), "Topology peer names");
  assertUnique(peers.map((peer) => peer.nodeId), "Topology node public ids");
  assertUnique(peers.map((peer) => peer.enode), "Topology enodes");
  assertUnique(validators.map((peer) => peer.address), "Topology validator addresses");

  const manifestValidatorAddresses = validators.map((validator) => validator.address).sort();
  const genesisValidatorAddresses = [...genesisValidators].sort();
  if (
    manifestValidatorAddresses.length !== genesisValidatorAddresses.length ||
    manifestValidatorAddresses.some((address, index) => address !== genesisValidatorAddresses[index])
  ) {
    fail("Topology validator addresses do not exactly match the QBFT genesis extraData validator list");
  }

  if (typeof topologyObject.localNode !== "string") fail("topology.localNode must identify this deployment node");
  const local = peers.find((peer) => peer.name === topologyObject.localNode);
  if (!local) fail(`topology.localNode ${topologyObject.localNode} is not present in validators or observers`);

  const staticSet = canonicalEnodeSet(staticNodes, "static-nodes.json");
  if (staticSet.size === 0) fail("Production static-nodes.json must not be empty");
  const permissionSet = canonicalEnodeSet(parsePermissionNodes(permissionsSource), "nodes-allowlist");
  if (permissionSet.size === 0) fail("Production nodes-allowlist must not be empty");

  const knownPeerEnodes = new Set(peers.map((peer) => peer.enode));
  for (const enode of staticSet) {
    if (!knownPeerEnodes.has(enode)) fail(`Static peer ${enode} is not approved by the topology manifest`);
    if (!permissionSet.has(enode)) fail(`Static peer ${enode} is absent from the Besu nodes-allowlist`);
  }
  for (const enode of permissionSet) {
    if (!knownPeerEnodes.has(enode)) fail(`Permissioned peer ${enode} is not approved by the topology manifest`);
  }

  const remoteValidators = validators.filter((validator) => validator.name !== local.name);
  for (const validator of remoteValidators) {
    if (!staticSet.has(validator.enode)) {
      fail(`Remote validator ${validator.name} must be a static peer so discovery-disabled QBFT can form quorum`);
    }
    if (!permissionSet.has(validator.enode)) {
      fail(`Remote validator ${validator.name} must be present in the Besu nodes-allowlist`);
    }
  }

  return {
    chainId: expected,
    localNode: local.name,
    localRole: local.role === "validators" ? "validator" : "observer",
    validatorCount: validators.length,
    observerCount: observers.length,
    staticPeerCount: staticSet.size,
    permissionedPeerCount: permissionSet.size,
    toleratedFaults,
    genesisSha256: actualGenesisHash,
  };
}

function requiredPath(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} must point to an operator-provisioned production file`);
  return value;
}

async function main() {
  const topologyPath = requiredPath("THREADPROOF_CONSORTIUM_TOPOLOGY_PATH");
  const genesisPath = requiredPath("THREADPROOF_BESU_GENESIS_PATH");
  const staticNodesPath = requiredPath("THREADPROOF_BESU_STATIC_NODES_PATH");
  const permissionsPath = requiredPath("THREADPROOF_BESU_PERMISSIONS_PATH");
  const expectedChainId = asPositiveInteger(process.env.THREADPROOF_CHAIN_ID ?? "2026", "THREADPROOF_CHAIN_ID");

  const [topologyText, genesisText, staticNodesText, permissionsSource] = await Promise.all([
    readFile(topologyPath, "utf8"),
    readFile(genesisPath, "utf8"),
    readFile(staticNodesPath, "utf8"),
    readFile(permissionsPath, "utf8"),
  ]);

  let topology;
  let genesis;
  let staticNodes;
  try {
    topology = JSON.parse(topologyText);
    genesis = JSON.parse(genesisText);
    staticNodes = JSON.parse(staticNodesText);
  } catch (error) {
    fail(`Production topology/genesis/static-node JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = validateConsortiumTopology({ topology, genesis, genesisText, staticNodes, permissionsSource, expectedChainId });
  console.log(
    `ThreadProof QBFT topology preflight passed for ${result.localNode}: ${result.validatorCount} validators, ` +
      `${result.toleratedFaults}-fault tolerance, ${result.staticPeerCount} static peers, chain ${result.chainId}.`,
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
