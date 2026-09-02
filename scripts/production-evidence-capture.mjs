const FORMAT = "threadproof-production-evidence-capture/v1";
const REQUIRED_CONTRACT_NAMES = Object.freeze([
  "Registry",
  "CredentialRegistry",
  "OrderRegistry",
  "CapacityVault",
  "SubcontractGovernor",
  "ThreadProofCharter",
]);
const REQUIRED_WORKER_TYPES = Object.freeze([
  "indexer",
  "order_relayer",
  "subcontract_relayer",
  "proof_generator",
  "proof_submitter",
  "capacity_release_generator",
  "capacity_release_submitter",
]);
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COMMIT = /^[0-9a-fA-F]{40}$/;
const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_HEARTBEAT_AGE_MS = 15 * 60 * 1000;
const FORBIDDEN_KEY = /(password|passwd|secret|private.?key|api.?key|authorization|access.?token|refresh.?token|service.?role.?key|factory.?secrets|data.?key)/i;
const FORBIDDEN_VALUE = /(bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=])/i;
const PLACEHOLDER = /(REPLACE_ME|PLACEHOLDER|CHANGEME|TODO|TBD)/i;

function fail(message) {
  throw new Error(`Production evidence capture: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function integer(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${label} must be an integer >= ${min}`);
  return value;
}

function hash32(value, label) {
  const normalized = string(value, label);
  if (!HASH32.test(normalized) || /^0x0{64}$/i.test(normalized)) fail(`${label} must be a non-zero bytes32 hash`);
  return normalized.toLowerCase();
}

function address(value, label) {
  const normalized = string(value, label);
  if (!ADDRESS.test(normalized) || /^0x0{40}$/i.test(normalized)) fail(`${label} must be a non-zero EVM address`);
  return normalized.toLowerCase();
}

function iso(value, label) {
  const normalized = string(value, label);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) fail(`${label} must be an ISO timestamp`);
  return { value: new Date(timestamp).toISOString(), timestamp };
}

function allowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unexpected field ${key}`);
  }
}

function optionalManifestHash(value, label) {
  if (typeof value !== "string" || value.trim() === "" || PLACEHOLDER.test(value)) return null;
  return hash32(value, label);
}

function same(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function scanNoSecrets(value, path = "capture") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is a secret-bearing field name`);
      scanNoSecrets(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) fail(`${path} appears to contain secret material`);
    if (/https?:\/\/[^/\s@]+:[^/\s@]+@/i.test(value)) fail(`${path} contains a credential-bearing URL`);
  }
}

function validateManifest(manifest) {
  const root = object(manifest, "release manifest");
  const release = object(root.release, "release manifest.release");
  const chain = object(root.chain, "release manifest.chain");
  const contracts = root.contracts;
  const verifiers = object(root.verifiers, "release manifest.verifiers");

  const version = string(release.version, "release.version");
  if (!SEMVER.test(version) || PLACEHOLDER.test(version)) fail("release.version must be a concrete semantic version");
  const sourceDevelopCommit = string(release.sourceDevelopCommit, "release.sourceDevelopCommit");
  if (!COMMIT.test(sourceDevelopCommit) || /^0{40}$/i.test(sourceDevelopCommit) || PLACEHOLDER.test(sourceDevelopCommit)) {
    fail("release.sourceDevelopCommit must be a concrete full Git SHA");
  }
  if (chain.chainId !== 2026) fail("release manifest must pin chain ID 2026");
  const genesisHash = hash32(chain.genesisHash, "chain.genesisHash");

  if (!Array.isArray(contracts) || contracts.length !== REQUIRED_CONTRACT_NAMES.length) {
    fail(`release manifest contracts must contain exactly ${REQUIRED_CONTRACT_NAMES.length} ThreadProof state contracts`);
  }
  const byName = new Map();
  for (const entry of contracts) {
    const item = object(entry, "release manifest contract");
    const name = string(item.name, "contract.name");
    if (!REQUIRED_CONTRACT_NAMES.includes(name)) fail(`release manifest contains unexpected contract ${name}`);
    if (byName.has(name)) fail(`release manifest duplicates contract ${name}`);
    byName.set(name, {
      name,
      address: address(item.address, `${name}.address`),
      runtimeCodeHash: optionalManifestHash(item.runtimeCodeHash, `${name}.runtimeCodeHash`),
    });
  }
  for (const name of REQUIRED_CONTRACT_NAMES) if (!byName.has(name)) fail(`release manifest is missing contract ${name}`);

  const normalizedVerifiers = {};
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const item = object(verifiers[key], `release manifest.verifiers.${key}`);
    normalizedVerifiers[key] = {
      circuitVersion: integer(item.circuitVersion, `${key}.circuitVersion`, { min: 1 }),
      address: address(item.address, `${key}.address`),
      runtimeCodeHash: optionalManifestHash(item.runtimeCodeHash, `${key}.runtimeCodeHash`),
      circuitArtifactHash: optionalManifestHash(item.circuitArtifactHash, `${key}.circuitArtifactHash`),
      verificationKeyHash: optionalManifestHash(item.verificationKeyHash, `${key}.verificationKeyHash`),
      buildAttestationSha256: optionalManifestHash(item.buildAttestationSha256, `${key}.buildAttestationSha256`),
      ceremonyEvidenceSha256: optionalManifestHash(item.ceremonyEvidenceSha256, `${key}.ceremonyEvidenceSha256`),
    };
  }

  return {
    version,
    sourceDevelopCommit: sourceDevelopCommit.toLowerCase(),
    genesisHash,
    contracts: byName,
    verifiers: normalizedVerifiers,
  };
}

function normalizeContractObservations(observations, manifest) {
  if (!Array.isArray(observations) || observations.length !== REQUIRED_CONTRACT_NAMES.length) {
    fail(`chain observation must contain exactly ${REQUIRED_CONTRACT_NAMES.length} state contracts`);
  }
  const byName = new Map();
  for (const entry of observations) {
    const item = object(entry, "chain contract observation");
    allowedKeys(item, new Set(["name", "address", "runtimeCodeHash"]), "chain contract observation");
    const name = string(item.name, "observed contract.name");
    if (!REQUIRED_CONTRACT_NAMES.includes(name)) fail(`chain observation contains unexpected contract ${name}`);
    if (byName.has(name)) fail(`chain observation duplicates contract ${name}`);
    const observedAddress = address(item.address, `${name}.observedAddress`);
    const runtimeCodeHash = hash32(item.runtimeCodeHash, `${name}.observedRuntimeCodeHash`);
    const expected = manifest.contracts.get(name);
    if (!same(observedAddress, expected.address)) fail(`${name} observed address does not match the release manifest`);
    if (expected.runtimeCodeHash && !same(runtimeCodeHash, expected.runtimeCodeHash)) {
      fail(`${name} observed runtime code hash does not match the release manifest`);
    }
    byName.set(name, { name, address: observedAddress, runtimeCodeHash });
  }
  for (const name of REQUIRED_CONTRACT_NAMES) if (!byName.has(name)) fail(`chain observation is missing contract ${name}`);
  return REQUIRED_CONTRACT_NAMES.map((name) => byName.get(name));
}

function normalizeVerifierObservation(key, observation, manifestVerifier) {
  const item = object(observation, `${key} verifier observation`);
  allowedKeys(
    item,
    new Set([
      "circuitVersion",
      "address",
      "runtimeCodeHash",
      "circuitArtifactHash",
      "verificationKeyHash",
      "buildAttestationSha256",
      "ceremonyEvidenceSha256",
      "vaultProvenance",
    ]),
    `${key} verifier observation`,
  );
  const circuitVersion = integer(item.circuitVersion, `${key}.observedCircuitVersion`, { min: 1 });
  if (circuitVersion !== manifestVerifier.circuitVersion) fail(`${key} circuit version does not match the release manifest`);
  const observedAddress = address(item.address, `${key}.observedAddress`);
  if (!same(observedAddress, manifestVerifier.address)) fail(`${key} verifier address does not match the release manifest`);
  const runtimeCodeHash = hash32(item.runtimeCodeHash, `${key}.runtimeCodeHash`);
  const circuitArtifactHash = hash32(item.circuitArtifactHash, `${key}.circuitArtifactHash`);
  const verificationKeyHash = hash32(item.verificationKeyHash, `${key}.verificationKeyHash`);
  const buildAttestationSha256 = hash32(item.buildAttestationSha256, `${key}.buildAttestationSha256`);
  const ceremonyEvidenceSha256 = hash32(item.ceremonyEvidenceSha256, `${key}.ceremonyEvidenceSha256`);

  for (const [field, observed] of Object.entries({
    runtimeCodeHash,
    circuitArtifactHash,
    verificationKeyHash,
    buildAttestationSha256,
    ceremonyEvidenceSha256,
  })) {
    if (manifestVerifier[field] && !same(observed, manifestVerifier[field])) {
      fail(`${key} observed ${field} does not match the release manifest`);
    }
  }

  const provenance = object(item.vaultProvenance, `${key}.vaultProvenance`);
  allowedKeys(
    provenance,
    new Set(["verifier", "circuitArtifactHash", "verificationKeyHash", "verifierCodeHash"]),
    `${key}.vaultProvenance`,
  );
  const vaultVerifier = address(provenance.verifier, `${key}.vaultProvenance.verifier`);
  const vaultCircuitHash = hash32(provenance.circuitArtifactHash, `${key}.vaultProvenance.circuitArtifactHash`);
  const vaultVerificationKeyHash = hash32(provenance.verificationKeyHash, `${key}.vaultProvenance.verificationKeyHash`);
  const vaultVerifierCodeHash = hash32(provenance.verifierCodeHash, `${key}.vaultProvenance.verifierCodeHash`);
  if (!same(vaultVerifier, observedAddress)) fail(`${key} CapacityVault provenance verifier does not match the deployed verifier`);
  if (!same(vaultCircuitHash, circuitArtifactHash)) fail(`${key} CapacityVault circuit provenance does not match the verifier wrapper`);
  if (!same(vaultVerificationKeyHash, verificationKeyHash)) fail(`${key} CapacityVault verification-key provenance does not match the verifier wrapper`);
  if (!same(vaultVerifierCodeHash, runtimeCodeHash)) fail(`${key} CapacityVault verifier-code provenance does not match live bytecode`);

  return {
    circuitVersion,
    address: observedAddress,
    runtimeCodeHash,
    circuitArtifactHash,
    verificationKeyHash,
    buildAttestationSha256,
    ceremonyEvidenceSha256,
    capacityVaultProvenanceVerified: true,
  };
}

function normalizeOperations(observation, sourceDevelopCommit, observedAtMs) {
  if (observation == null) return { included: false, reason: "operator-did-not-request-supabase-read" };
  const root = object(observation, "operations observation");
  allowedKeys(root, new Set(["workerHeartbeats", "indexerCursor"]), "operations observation");
  if (!Array.isArray(root.workerHeartbeats) || root.workerHeartbeats.length !== REQUIRED_WORKER_TYPES.length) {
    fail(`operations observation must contain exactly ${REQUIRED_WORKER_TYPES.length} latest worker heartbeats`);
  }
  const heartbeatByType = new Map();
  const allowedHeartbeatKeys = new Set([
    "worker_type",
    "status",
    "chain_id",
    "build_commit",
    "started_at",
    "last_heartbeat_at",
    "last_success_at",
    "error_code",
  ]);
  for (const raw of root.workerHeartbeats) {
    const row = object(raw, "worker heartbeat");
    allowedKeys(row, allowedHeartbeatKeys, "worker heartbeat");
    const workerType = string(row.worker_type, "worker heartbeat.worker_type");
    if (!REQUIRED_WORKER_TYPES.includes(workerType)) fail(`unexpected worker heartbeat type ${workerType}`);
    if (heartbeatByType.has(workerType)) fail(`duplicate worker heartbeat type ${workerType}`);
    if (row.status !== "ready") fail(`${workerType} heartbeat is not ready`);
    if (row.chain_id !== 2026) fail(`${workerType} heartbeat is bound to the wrong chain`);
    const buildCommit = string(row.build_commit, `${workerType}.build_commit`).toLowerCase();
    if (!COMMIT.test(buildCommit) || buildCommit !== sourceDevelopCommit) fail(`${workerType} heartbeat build commit does not match release source`);
    const started = iso(row.started_at, `${workerType}.started_at`);
    const heartbeat = iso(row.last_heartbeat_at, `${workerType}.last_heartbeat_at`);
    const success = iso(row.last_success_at, `${workerType}.last_success_at`);
    if (started.timestamp > heartbeat.timestamp || heartbeat.timestamp > observedAtMs) fail(`${workerType} heartbeat timestamps are inconsistent`);
    if (observedAtMs - heartbeat.timestamp > MAX_HEARTBEAT_AGE_MS) fail(`${workerType} heartbeat is stale`);
    if (success.timestamp > observedAtMs) fail(`${workerType} last_success_at is in the future`);
    if (row.error_code !== null) fail(`${workerType} heartbeat reports error_code ${row.error_code}`);
    heartbeatByType.set(workerType, {
      workerType,
      status: "ready",
      chainId: 2026,
      buildCommit,
      startedAt: started.value,
      lastHeartbeatAt: heartbeat.value,
      lastSuccessAt: success.value,
      errorCode: null,
    });
  }
  for (const type of REQUIRED_WORKER_TYPES) if (!heartbeatByType.has(type)) fail(`missing worker heartbeat ${type}`);

  const cursor = object(root.indexerCursor, "indexer cursor observation");
  allowedKeys(
    cursor,
    new Set([
      "chain_id",
      "last_block_number",
      "last_block_hash",
      "status",
      "error_code",
      "updated_at",
      "canonical_block_hash",
      "configured_confirmation_depth",
      "observed_head_distance",
    ]),
    "indexer cursor observation",
  );
  if (cursor.chain_id !== 2026) fail("indexer cursor is bound to the wrong chain");
  const lastBlockNumber = integer(cursor.last_block_number, "indexer cursor.last_block_number", { min: 0 });
  const lastBlockHash = hash32(cursor.last_block_hash, "indexer cursor.last_block_hash");
  if (cursor.status !== "healthy" || cursor.error_code !== null) fail("indexer cursor is quarantined or unhealthy");
  const updatedAt = iso(cursor.updated_at, "indexer cursor.updated_at");
  if (updatedAt.timestamp > observedAtMs) fail("indexer cursor updated_at is in the future");
  const canonicalBlockHash = hash32(cursor.canonical_block_hash, "indexer cursor.canonical_block_hash");
  if (!same(lastBlockHash, canonicalBlockHash)) fail("indexer cursor hash does not match canonical RPC block hash");
  const configuredConfirmationDepth = integer(cursor.configured_confirmation_depth, "indexer cursor.configured_confirmation_depth", { min: 1 });
  const observedHeadDistance = integer(cursor.observed_head_distance, "indexer cursor.observed_head_distance", { min: 0 });
  if (observedHeadDistance < configuredConfirmationDepth) fail("indexer cursor has not reached the configured confirmation depth");

  return {
    included: true,
    workerHeartbeats: REQUIRED_WORKER_TYPES.map((type) => heartbeatByType.get(type)),
    indexerCursor: {
      chainId: 2026,
      lastBlockNumber,
      lastBlockHash,
      status: "healthy",
      errorCode: null,
      updatedAt: updatedAt.value,
      canonicalBlockHashVerified: true,
      configuredConfirmationDepth,
      observedHeadDistance,
    },
  };
}

export function buildProductionEvidenceCapture({ manifest, chainObservation, operationsObservation = null, observedAt }) {
  const normalizedManifest = validateManifest(manifest);
  const observed = object(chainObservation, "chain observation");
  allowedKeys(observed, new Set(["chainId", "genesisHash", "latestBlockNumber", "latestBlockHash", "contracts", "verifiers"]), "chain observation");
  if (observed.chainId !== 2026) fail("observed RPC is serving the wrong chain ID");
  const observedGenesisHash = hash32(observed.genesisHash, "observed genesis hash");
  if (!same(observedGenesisHash, normalizedManifest.genesisHash)) fail("observed genesis hash does not match the release manifest");
  const latestBlockNumber = integer(observed.latestBlockNumber, "latest block number", { min: 0 });
  const latestBlockHash = hash32(observed.latestBlockHash, "latest block hash");
  const contracts = normalizeContractObservations(observed.contracts, normalizedManifest);
  const verifierRoot = object(observed.verifiers, "verifier observations");
  allowedKeys(verifierRoot, new Set(["capacitySpend", "capacityRelease"]), "verifier observations");
  const verifiers = {
    capacitySpend: normalizeVerifierObservation("capacitySpend", verifierRoot.capacitySpend, normalizedManifest.verifiers.capacitySpend),
    capacityRelease: normalizeVerifierObservation("capacityRelease", verifierRoot.capacityRelease, normalizedManifest.verifiers.capacityRelease),
  };
  const observedTimestamp = iso(observedAt ?? new Date().toISOString(), "observedAt");
  const operations = normalizeOperations(operationsObservation, normalizedManifest.sourceDevelopCommit, observedTimestamp.timestamp);

  const artifact = {
    format: FORMAT,
    schemaVersion: 1,
    result: "incomplete",
    completion: "operator-review-required",
    observedAt: observedTimestamp.value,
    release: {
      version: normalizedManifest.version,
      sourceDevelopCommit: normalizedManifest.sourceDevelopCommit,
    },
    chain: {
      chainId: 2026,
      genesisHash: observedGenesisHash,
      latestBlockNumber,
      latestBlockHash,
    },
    contracts,
    verifiers,
    operations,
    operatorReviewRequired: [
      "validator-administrative-independence",
      "tls-and-private-network-controls",
      "node-and-account-permissioning",
      "persistent-storage-and-monitoring-controls",
      "backup-configuration-and-recovery-evidence",
      "remote-web3signer-kms-or-hsm-custody",
      "evidence-urls-and-digests",
      "independent-reviewer-identities-and-signoff",
      "stakeholder-uat-and-adversarial-evidence",
      "final-production-result-and-approval",
    ],
  };
  scanNoSecrets(artifact);
  return artifact;
}

export function assertProductionEvidenceCaptureSafe(artifact) {
  const value = object(artifact, "capture artifact");
  if (value.format !== FORMAT || value.schemaVersion !== 1) fail("unsupported capture artifact format");
  if (value.result !== "incomplete" || value.completion !== "operator-review-required") {
    fail("capture artifacts must remain explicitly incomplete and operator-review-required");
  }
  if ("signing" in value || "validators" in value || "signoff" in value || "reviewers" in value) {
    fail("capture artifact contains fields reserved for independent operator/consortium evidence");
  }
  scanNoSecrets(value);
  return true;
}

export { FORMAT, MAX_HEARTBEAT_AGE_MS, REQUIRED_CONTRACT_NAMES, REQUIRED_WORKER_TYPES };
