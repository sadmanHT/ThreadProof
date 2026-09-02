import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  THREADPROOF_BASELINE_VALIDATOR_COUNT,
} from "./qbft-network-policy.mjs";
import { validateConsortiumTopology } from "./validate-consortium-topology.mjs";

function fail(message) {
  throw new Error(message);
}

function requiredPath(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} must point to an operator-provisioned production file.`);
  return value;
}

function parseExpectedChainId() {
  const text = process.env.THREADPROOF_CHAIN_ID?.trim() || "2026";
  if (!/^\d+$/.test(text)) fail("THREADPROOF_CHAIN_ID must be a positive integer.");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) fail("THREADPROOF_CHAIN_ID must be a positive integer.");
  return value;
}

async function main() {
  const topologyPath = requiredPath("THREADPROOF_CONSORTIUM_TOPOLOGY_PATH");
  const genesisPath = requiredPath("THREADPROOF_BESU_GENESIS_PATH");
  const staticNodesPath = requiredPath("THREADPROOF_BESU_STATIC_NODES_PATH");
  const permissionsPath = requiredPath("THREADPROOF_BESU_PERMISSIONS_PATH");
  const expectedChainId = parseExpectedChainId();

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

  if (!Array.isArray(topology?.validators) || topology.validators.length < THREADPROOF_BASELINE_VALIDATOR_COUNT) {
    fail(
      `ThreadProof production requires at least ${THREADPROOF_BASELINE_VALIDATOR_COUNT} validators; ` +
        `found ${Array.isArray(topology?.validators) ? topology.validators.length : "invalid"}.`,
    );
  }

  const result = validateConsortiumTopology({
    topology,
    genesis,
    genesisText,
    staticNodes,
    permissionsSource,
    expectedChainId,
  });
  if (result.validatorCount < THREADPROOF_BASELINE_VALIDATOR_COUNT) {
    fail(`Validated topology fell below the ThreadProof ${THREADPROOF_BASELINE_VALIDATOR_COUNT}-validator baseline.`);
  }

  console.log(
    `ThreadProof production topology preflight passed for ${result.localNode}: ${result.validatorCount} validators, ` +
      `${result.toleratedFaults}-fault QBFT tolerance, ${result.staticPeerCount} static peers, chain ${result.chainId}.`,
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
