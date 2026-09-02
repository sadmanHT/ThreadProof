#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, JsonRpcProvider, keccak256 } from "ethers";
import {
  assertProductionEvidenceCaptureSafe,
  buildProductionEvidenceCapture,
  REQUIRED_CONTRACT_NAMES,
  REQUIRED_WORKER_TYPES,
} from "../../../scripts/production-evidence-capture.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDER = /(REPLACE_ME|PLACEHOLDER|CHANGEME|TODO|TBD)/i;
const ALLOWED_ARGS = new Set(["manifest", "output"]);
const VERIFIER_ABI = [
  "function circuitArtifactHash() view returns (bytes32)",
  "function verificationKeyHash() view returns (bytes32)",
  "function buildAttestationSha256() view returns (bytes32)",
  "function ceremonyEvidenceSha256() view returns (bytes32)",
];
const VAULT_ABI = [
  "function getVerifierProvenance(uint32) view returns (address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt)",
  "function getReleaseVerifierProvenance(uint32) view returns (address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt)",
];
const WORKER_SELECT = "worker_type,status,chain_id,build_commit,started_at,last_heartbeat_at,last_success_at,error_code";
const CURSOR_SELECT = "chain_id,last_block_number,last_block_hash,status,error_code,updated_at";

function fail(message) {
  throw new Error(`Production evidence live capture: ${message}`);
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value) || PLACEHOLDER.test(value)) {
    fail(`${label} must be a concrete non-zero EVM address`);
  }
  return value.toLowerCase();
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
  return parsed;
}

function safeUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} must be a valid URL`);
  }
  if (parsed.username || parsed.password) fail(`${label} must not contain embedded credentials`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail(`${label} must use HTTP(S)`);
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  let includeSupabase = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue;
    if (token === "--include-supabase") {
      includeSupabase = true;
      continue;
    }
    if (!token.startsWith("--")) fail(`unexpected positional argument ${token}`);
    const key = token.slice(2);
    if (!ALLOWED_ARGS.has(key)) fail(`unsupported argument --${key}; secrets must never be supplied on the command line`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    values.set(key, value);
    i += 1;
  }
  for (const key of ALLOWED_ARGS) if (!values.get(key)) fail(`missing required --${key}`);
  return { manifestPath: resolve(values.get("manifest")), outputPath: resolve(values.get("output")), includeSupabase };
}

function releaseBindings(manifest) {
  if (!manifest || typeof manifest !== "object") fail("release manifest must be an object");
  if (manifest.chain?.chainId !== 2026) fail("release manifest must pin chain ID 2026");
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length !== REQUIRED_CONTRACT_NAMES.length) {
    fail("release manifest must enumerate the exact six ThreadProof state contracts");
  }
  const contracts = new Map();
  for (const entry of manifest.contracts) {
    if (!REQUIRED_CONTRACT_NAMES.includes(entry?.name)) fail(`release manifest contains unexpected contract ${entry?.name ?? "<missing>"}`);
    if (contracts.has(entry.name)) fail(`release manifest duplicates contract ${entry.name}`);
    contracts.set(entry.name, requireAddress(entry.address, `${entry.name}.address`));
  }
  for (const name of REQUIRED_CONTRACT_NAMES) if (!contracts.has(name)) fail(`release manifest is missing contract ${name}`);
  const verifiers = {};
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const entry = manifest.verifiers?.[key];
    if (!entry || typeof entry !== "object") fail(`release manifest is missing verifier ${key}`);
    verifiers[key] = {
      address: requireAddress(entry.address, `verifiers.${key}.address`),
      circuitVersion: parsePositiveInteger(entry.circuitVersion, `verifiers.${key}.circuitVersion`),
    };
  }
  return { contracts, verifiers };
}

async function requireBlock(rpc, tag, label) {
  const block = await rpc.getBlock(tag);
  if (!block || !Number.isSafeInteger(Number(block.number)) || typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    fail(`${label} block is unavailable or missing a canonical hash`);
  }
  return { number: Number(block.number), hash: block.hash.toLowerCase() };
}

async function runtimeHash(rpc, contractAddress, label) {
  const code = await rpc.getCode(contractAddress);
  if (typeof code !== "string" || code === "0x" || !/^0x[0-9a-fA-F]+$/.test(code)) fail(`${label} has no deployed runtime bytecode`);
  return keccak256(code).toLowerCase();
}

function tupleProvenance(tuple, label) {
  if (!tuple || tuple.length < 4) fail(`${label} provenance response is incomplete`);
  return {
    verifier: String(tuple[0]).toLowerCase(),
    circuitArtifactHash: String(tuple[1]).toLowerCase(),
    verificationKeyHash: String(tuple[2]).toLowerCase(),
    verifierCodeHash: String(tuple[3]).toLowerCase(),
  };
}

export function createEthersCaptureRpc(rpcUrl) {
  safeUrl(rpcUrl, "THREADPROOF_RPC_URL");
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
  return {
    async getChainId() {
      return Number((await provider.getNetwork()).chainId);
    },
    async getBlock(tag) {
      return provider.getBlock(tag);
    },
    async getCode(contractAddress) {
      return provider.getCode(contractAddress);
    },
    async readVerifier(verifierAddress) {
      const verifier = new Contract(verifierAddress, VERIFIER_ABI, provider);
      const [circuitArtifactHash, verificationKeyHash, buildAttestationSha256, ceremonyEvidenceSha256] = await Promise.all([
        verifier.circuitArtifactHash(),
        verifier.verificationKeyHash(),
        verifier.buildAttestationSha256(),
        verifier.ceremonyEvidenceSha256(),
      ]);
      return { circuitArtifactHash, verificationKeyHash, buildAttestationSha256, ceremonyEvidenceSha256 };
    },
    async readCapacityVaultProvenance(vaultAddress, circuitVersion, kind) {
      const vault = new Contract(vaultAddress, VAULT_ABI, provider);
      const tuple = kind === "capacitySpend"
        ? await vault.getVerifierProvenance(circuitVersion)
        : await vault.getReleaseVerifierProvenance(circuitVersion);
      return tupleProvenance(tuple, kind);
    },
  };
}

export async function captureChainObservation(manifest, rpc) {
  const bindings = releaseBindings(manifest);
  const chainId = await rpc.getChainId();
  if (chainId !== 2026) fail(`RPC returned chain ID ${chainId}; expected 2026`);
  const [genesis, latest] = await Promise.all([
    requireBlock(rpc, 0, "genesis"),
    requireBlock(rpc, "latest", "latest"),
  ]);
  const contracts = [];
  for (const name of REQUIRED_CONTRACT_NAMES) {
    const contractAddress = bindings.contracts.get(name);
    contracts.push({
      name,
      address: contractAddress,
      runtimeCodeHash: await runtimeHash(rpc, contractAddress, name),
    });
  }
  const vaultAddress = bindings.contracts.get("CapacityVault");
  const verifiers = {};
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const binding = bindings.verifiers[key];
    const [runtimeCodeHash, wrapper, vaultProvenance] = await Promise.all([
      runtimeHash(rpc, binding.address, `${key} verifier`),
      rpc.readVerifier(binding.address),
      rpc.readCapacityVaultProvenance(vaultAddress, binding.circuitVersion, key),
    ]);
    verifiers[key] = {
      circuitVersion: binding.circuitVersion,
      address: binding.address,
      runtimeCodeHash,
      circuitArtifactHash: String(wrapper.circuitArtifactHash).toLowerCase(),
      verificationKeyHash: String(wrapper.verificationKeyHash).toLowerCase(),
      buildAttestationSha256: String(wrapper.buildAttestationSha256).toLowerCase(),
      ceremonyEvidenceSha256: String(wrapper.ceremonyEvidenceSha256).toLowerCase(),
      vaultProvenance,
    };
  }
  return {
    chainId,
    genesisHash: genesis.hash,
    latestBlockNumber: latest.number,
    latestBlockHash: latest.hash,
    contracts,
    verifiers,
  };
}

async function supabaseJson(fetchImpl, baseUrl, serviceRoleKey, relativePath) {
  const response = await fetchImpl(new URL(relativePath, baseUrl), {
    method: "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) fail(`sanitized Supabase operational read failed with HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) fail("sanitized Supabase operational read did not return an array");
  return data;
}

function latestHeartbeatPerType(rows) {
  const latest = new Map();
  for (const row of rows) {
    const type = row?.worker_type;
    if (!REQUIRED_WORKER_TYPES.includes(type)) continue;
    const timestamp = Date.parse(row?.last_heartbeat_at ?? "");
    if (!Number.isFinite(timestamp)) continue;
    const existing = latest.get(type);
    if (!existing || timestamp > Date.parse(existing.last_heartbeat_at)) latest.set(type, row);
  }
  return REQUIRED_WORKER_TYPES.map((type) => latest.get(type)).filter(Boolean);
}

export async function captureOperationsObservation({ fetchImpl = fetch, supabaseUrl, serviceRoleKey, rpc, latestBlockNumber, confirmationDepth }) {
  const baseUrl = safeUrl(supabaseUrl, "SUPABASE_URL");
  if (baseUrl.protocol !== "https:") fail("SUPABASE_URL must use HTTPS");
  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20) fail("SUPABASE_SERVICE_ROLE_KEY is missing or invalid");
  const workerPath = `/rest/v1/worker_runtime_heartbeats?select=${encodeURIComponent(WORKER_SELECT)}&order=worker_type.asc,last_heartbeat_at.desc`;
  const cursorPath = `/rest/v1/chain_indexer_cursors?select=${encodeURIComponent(CURSOR_SELECT)}&chain_id=eq.2026&limit=1`;
  const [workerRows, cursorRows] = await Promise.all([
    supabaseJson(fetchImpl, baseUrl, serviceRoleKey, workerPath),
    supabaseJson(fetchImpl, baseUrl, serviceRoleKey, cursorPath),
  ]);
  const workerHeartbeats = latestHeartbeatPerType(workerRows);
  if (cursorRows.length !== 1) fail("expected exactly one chain-2026 sanitized indexer cursor");
  const cursor = cursorRows[0];
  const cursorBlockNumber = Number(cursor?.last_block_number);
  if (!Number.isSafeInteger(cursorBlockNumber) || cursorBlockNumber < 0 || cursorBlockNumber > latestBlockNumber) {
    fail("sanitized indexer cursor block number is invalid or ahead of the observed RPC head");
  }
  const canonical = await requireBlock(rpc, cursorBlockNumber, "indexer cursor canonical");
  return {
    workerHeartbeats,
    indexerCursor: {
      ...cursor,
      canonical_block_hash: canonical.hash,
      configured_confirmation_depth: confirmationDepth,
      observed_head_distance: latestBlockNumber - cursorBlockNumber,
    },
  };
}

export async function captureProductionEvidence({ manifest, rpc, includeSupabase = false, fetchImpl = fetch, supabaseUrl, serviceRoleKey, confirmationDepth = 1, observedAt }) {
  const chainObservation = await captureChainObservation(manifest, rpc);
  const operationsObservation = includeSupabase
    ? await captureOperationsObservation({
        fetchImpl,
        supabaseUrl,
        serviceRoleKey,
        rpc,
        latestBlockNumber: chainObservation.latestBlockNumber,
        confirmationDepth,
      })
    : null;
  const artifact = buildProductionEvidenceCapture({ manifest, chainObservation, operationsObservation, observedAt });
  assertProductionEvidenceCaptureSafe(artifact);
  return artifact;
}

function sanitizedError(error) {
  const raw = error instanceof Error ? error.message : "unknown failure";
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "<redacted-url>")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .slice(0, 500);
}

async function main() {
  const { manifestPath, outputPath, includeSupabase } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  if (!rpcUrl) fail("THREADPROOF_RPC_URL is required");
  const rpc = createEthersCaptureRpc(rpcUrl);
  const confirmationDepth = includeSupabase
    ? parsePositiveInteger(process.env.THREADPROOF_CONFIRMATIONS ?? "", "THREADPROOF_CONFIRMATIONS")
    : 1;
  const artifact = await captureProductionEvidence({
    manifest,
    rpc,
    includeSupabase,
    supabaseUrl: includeSupabase ? process.env.SUPABASE_URL : undefined,
    serviceRoleKey: includeSupabase ? process.env.SUPABASE_SERVICE_ROLE_KEY : undefined,
    confirmationDepth,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(outputPath, bytes, { encoding: "utf8", mode: 0o600 });
  console.log(`THREADPROOF_PRODUCTION_EVIDENCE_CAPTURE {"result":"incomplete","bytes":${Buffer.byteLength(bytes)},"operatorReviewRequired":true}`);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`ThreadProof production evidence capture failed: ${sanitizedError(error)}`);
    process.exitCode = 1;
  });
}

export { CURSOR_SELECT, WORKER_SELECT };
