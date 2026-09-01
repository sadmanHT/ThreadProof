import { createECDH, createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConsortiumTopology, validatorAddressFromNodeId } from "./validate-consortium-topology.mjs";

const BESU_IMAGE = "hyperledger/besu:26.8.0";
const CHAIN_ID = 2026;
const VALIDATOR_COUNT = 5;
const PILOT_SUBNET_PREFIX = "172.28.0.";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PILOT_DIR = join(REPO_ROOT, "infrastructure", "besu", "pilot");
const RUNTIME_DIR = join(PILOT_DIR, "runtime");
const GENERATED_DIR = join(RUNTIME_DIR, "generated");
const COMPOSE_FILE = join(PILOT_DIR, "docker-compose.yml");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.${detail}`);
  }
  return result.stdout ?? "";
}

function ensureDocker() {
  run("docker", ["version", "--format", "{{.Server.Version}}"], { capture: true });
  run("docker", ["compose", "version"], { capture: true });
}

function dockerHostUserArgs() {
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    return ["--user", `${process.getuid()}:${process.getgid()}`];
  }
  return [];
}

async function findNamedFiles(root, name) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  }
  await walk(root);
  return found;
}

function normalizeNodeId(value, label) {
  let hex = value.trim().replace(/^0x/i, "");
  if (/^04[0-9a-fA-F]{128}$/.test(hex)) hex = hex.slice(2);
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error(`${label} must contain a 64-byte uncompressed secp256k1 public key without the 0x04 prefix.`);
  }
  return hex.toLowerCase();
}

function disposablePrivateKey() {
  while (true) {
    const candidate = randomBytes(32);
    try {
      const ecdh = createECDH("secp256k1");
      ecdh.setPrivateKey(candidate);
      return candidate.toString("hex");
    } catch {
      // Extremely unlikely invalid scalar; generate another candidate.
    }
  }
}

function pilotContainerPath(hostPath) {
  const rel = relative(PILOT_DIR, hostPath).split("\\").join("/");
  if (rel.startsWith("..")) throw new Error(`Pilot path escaped its runtime root: ${hostPath}`);
  return `/work/${rel}`;
}

function besuPublicKey(keyPath, outputPath) {
  run("docker", [
    "run", "--rm",
    ...dockerHostUserArgs(),
    "-v", `${PILOT_DIR}:/work`,
    BESU_IMAGE,
    "public-key", "export",
    `--node-private-key-file=${pilotContainerPath(keyPath)}`,
    `--to=${pilotContainerPath(outputPath)}`,
  ]);
}

async function prepare() {
  ensureDocker();
  await rm(RUNTIME_DIR, { recursive: true, force: true });
  // Runtime manifests and validator bind paths must be traversable by Besu's non-root
  // container user. The funded deployer secret is isolated below in its own 0700 dir.
  await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o755 });

  run("docker", [
    "run", "--rm",
    ...dockerHostUserArgs(),
    "-v", `${PILOT_DIR}:/work`,
    BESU_IMAGE,
    "operator", "generate-blockchain-config",
    "--config-file=/work/qbftConfigFile.json",
    "--to=/work/runtime/generated",
    "--private-key-file-name=key",
  ]);

  const generatedKeys = (await findNamedFiles(GENERATED_DIR, "key")).sort();
  if (generatedKeys.length !== VALIDATOR_COUNT) {
    throw new Error(`Besu generated ${generatedKeys.length} validator keys; expected ${VALIDATOR_COUNT}.`);
  }

  const validators = [];
  const staticNodes = [];
  for (let index = 0; index < generatedKeys.length; index += 1) {
    const ordinal = index + 1;
    const validatorDir = join(RUNTIME_DIR, `validator-${ordinal}`);
    const keyPath = join(validatorDir, "key");
    const publicKeyPath = join(validatorDir, "key.pub");
    await mkdir(validatorDir, { recursive: true, mode: 0o755 });
    await cp(generatedKeys[index], keyPath);
    // Validator node identities are disposable pilot material and mounted read-only.
    // 0444 avoids UID coupling between the host and the pinned non-root Besu image.
    await chmod(keyPath, 0o444);
    besuPublicKey(keyPath, publicKeyPath);
    const nodeId = normalizeNodeId(await readFile(publicKeyPath, "utf8"), `validator-${ordinal} public key`);
    const address = validatorAddressFromNodeId(nodeId);
    const enode = `enode://${nodeId}@${PILOT_SUBNET_PREFIX}${10 + ordinal}:30303`;
    validators.push({ name: `validator-${ordinal}`, address, enode });
    staticNodes.push(enode);
  }

  const deployerDir = join(RUNTIME_DIR, "deployer");
  const deployerKeyPath = join(deployerDir, "key");
  const deployerPublicKeyPath = join(deployerDir, "key.pub");
  await mkdir(deployerDir, { recursive: true, mode: 0o700 });
  const deployerPrivateKey = disposablePrivateKey();
  await writeFile(deployerKeyPath, `${deployerPrivateKey}\n`, { mode: 0o600 });
  besuPublicKey(deployerKeyPath, deployerPublicKeyPath);
  const deployerNodeId = normalizeNodeId(await readFile(deployerPublicKeyPath, "utf8"), "pilot deployer public key");
  const deployerAddress = validatorAddressFromNodeId(deployerNodeId);

  const generatedGenesisPath = join(GENERATED_DIR, "genesis.json");
  const genesis = JSON.parse(await readFile(generatedGenesisPath, "utf8"));
  if (Number(genesis?.config?.chainId) !== CHAIN_ID) {
    throw new Error(`Generated genesis chain ID ${genesis?.config?.chainId ?? "missing"} does not equal ${CHAIN_ID}.`);
  }
  genesis.alloc ??= {};
  genesis.alloc[deployerAddress.slice(2)] = { balance: "0x3635c9adc5dea00000" };
  const genesisText = `${JSON.stringify(genesis, null, 2)}\n`;
  const genesisPath = join(RUNTIME_DIR, "genesis.json");
  await writeFile(genesisPath, genesisText);

  const staticNodesText = `${JSON.stringify(staticNodes, null, 2)}\n`;
  const staticNodesPath = join(RUNTIME_DIR, "static-nodes.json");
  await writeFile(staticNodesPath, staticNodesText);

  const permissionsSource = `nodes-allowlist=${JSON.stringify(staticNodes, null, 2)}\naccounts-allowlist=[]\n`;
  const permissionsPath = join(RUNTIME_DIR, "permissions_config.toml");
  await writeFile(permissionsPath, permissionsSource);

  const genesisSha256 = createHash("sha256").update(genesisText, "utf8").digest("hex");
  const topology = {
    chainId: CHAIN_ID,
    consensus: "qbft",
    genesisSha256,
    localNode: "validator-1",
    validators,
    observers: [],
  };
  const topologyPath = join(RUNTIME_DIR, "consortium-topology.json");
  await writeFile(topologyPath, `${JSON.stringify(topology, null, 2)}\n`);

  validateConsortiumTopology({
    topology,
    genesis,
    genesisText,
    staticNodes,
    permissionsSource,
    expectedChainId: CHAIN_ID,
  });

  const pilotEnv = [
    "# Generated by scripts/pilot-chain.mjs. Disposable development material; never promote to staging/production.",
    "THREADPROOF_DEPLOYMENT_ENV=development",
    `THREADPROOF_CHAIN_ID=${CHAIN_ID}`,
    "THREADPROOF_RPC_URL=http://127.0.0.1:8545",
    `DEV_DEPLOYER_PRIVATE_KEY=0x${deployerPrivateKey}`,
    `THREADPROOF_PILOT_DEPLOYER_ADDRESS=${deployerAddress}`,
    "",
  ].join("\n");
  await writeFile(join(RUNTIME_DIR, "pilot.env"), pilotEnv, { mode: 0o600 });

  console.log(`Prepared disposable ThreadProof QBFT pilot: ${VALIDATOR_COUNT} validators, chain ${CHAIN_ID}.`);
  console.log(`Genesis SHA-256: ${genesisSha256}`);
  console.log(`Funded deployer: ${deployerAddress}`);
  console.log(`Runtime material: ${RUNTIME_DIR}`);
}

async function rpc(method, params = []) {
  const response = await fetch("http://127.0.0.1:8545", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function verify() {
  let lastError;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const chainId = Number(BigInt(await rpc("eth_chainId")));
      if (chainId !== CHAIN_ID) throw new Error(`RPC reports chain ${chainId}; expected ${CHAIN_ID}.`);
      const blockNumber = Number(BigInt(await rpc("eth_blockNumber")));
      const peerCount = Number(BigInt(await rpc("net_peerCount")));
      const validators = await rpc("qbft_getValidatorsByBlockNumber", ["latest"]);
      if (!Array.isArray(validators) || validators.length !== VALIDATOR_COUNT) {
        throw new Error(`QBFT reports ${Array.isArray(validators) ? validators.length : "invalid"} validators; expected ${VALIDATOR_COUNT}.`);
      }
      if (peerCount < VALIDATOR_COUNT - 1) throw new Error(`validator1 sees only ${peerCount} peers; expected at least ${VALIDATOR_COUNT - 1}.`);
      if (blockNumber < 1) throw new Error("QBFT has not produced its first post-genesis block yet.");
      console.log(`ThreadProof pilot healthy: chain ${chainId}, block ${blockNumber}, ${validators.length} validators, ${peerCount} peers.`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ThreadProof pilot RPC did not become healthy.");
}

function compose(...args) {
  run("docker", ["compose", "-f", COMPOSE_FILE, ...args], { cwd: PILOT_DIR });
}

async function runtimePrepared() {
  try {
    await readFile(join(RUNTIME_DIR, "genesis.json"));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const command = process.argv[2] ?? "prepare";
  if (command === "prepare") return prepare();
  if (command === "up") {
    if (!(await runtimePrepared())) await prepare();
    ensureDocker();
    compose("up", "-d");
    return verify();
  }
  if (command === "verify") return verify();
  if (command === "down") {
    ensureDocker();
    compose("down");
    return;
  }
  if (command === "reset") {
    ensureDocker();
    compose("down", "-v", "--remove-orphans");
    await rm(RUNTIME_DIR, { recursive: true, force: true });
    console.log("Removed ThreadProof pilot containers, volumes, and disposable runtime secrets.");
    return;
  }
  throw new Error(`Unknown pilot command ${command}. Use prepare, up, verify, down, or reset.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
