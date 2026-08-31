import { createHash } from "node:crypto";
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

function parsePeerEntries(entries, role) {
  if (!Array.isArray(entries)) fail(`topology.${role} must be an array`);
  return entries.map((entry, index) => {
    const object = asObject(entry, `topology.${role}[${index}]`);
    if (typeof object.name !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(object.name)) {
      fail(`topology.${role}[${index}].name must be a stable lowercase DNS-style label`);
    }
    const parsed = parseEnode(object.enode, `topology.${role}[${index}].enode`);
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
  if (String(topologyObject.consensus).toLowerCase() !== "qbft") {
    fail("Topology consensus must be qbft");
  }

  const genesisConfig = asObject(genesisObject.config, "genesis.config");
  const genesisChainId = asPositiveInteger(genesisConfig.chainId, "genesis.config.chainId");
  if (genesisChainId !== expected) {
    fail(`Genesis chain ID ${genesisChainId} does not match expected ThreadProof chain ID ${expected}`);
  }
  asObject(genesisConfig.qbft, "genesis.config.qbft");
  if (typeof genesisObject.extraData !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(genesisObject.extraData) || genesisObject.extraData.length <= 66) {
    fail("QBFT genesis extraData must be a non-empty even-length hex payload beyond the 32-byte vanity field");
  }
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
  const toleratedFaults = Math.floor((validators.length - 1) / 3);
  if (toleratedFaults < 1) fail("QBFT topology must tolerate at least one validator fault");

  const peers = [...validators, ...observers];
  assertUnique(peers.map((peer) => peer.name), "Topology peer names");
  assertUnique(peers.map((peer) => peer.nodeId), "Topology node public ids");
  assertUnique(peers.map((peer) => peer.enode), "Topology enodes");

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
