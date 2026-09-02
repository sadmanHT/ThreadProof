#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEPLOYMENT_FORMAT = "threadproof-production-deployment/v1";
export const REQUIRED_CONTRACTS = [
  "Registry",
  "CredentialRegistry",
  "OrderRegistry",
  "CapacityVault",
  "SubcontractGovernor",
  "ThreadProofCharter",
];
export const REQUIRED_SERVICES = [
  "event_indexer",
  "order_relayer",
  "subcontract_relayer",
  "capacity_spend_proof_generator",
  "capacity_spend_submitter",
  "capacity_release_proof_generator",
  "capacity_release_submitter",
];

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_20 = /^0x[0-9a-fA-F]{40}$/;
const NODE_ID = /^0x[0-9a-fA-F]{128}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const DOMAIN_ID = /^[a-z0-9][a-z0-9._:-]{2,79}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FORBIDDEN_TEXT = /(^|[^a-z])(todo|tbd|placeholder|replace[_ -]?me|dummy|changeme|example)([^a-z]|$)/i;
const FORBIDDEN_KEY = /(password|private.?key|mnemonic|seed.?phrase|access.?token|service.?role.?key|api.?key|client.?secret|bearer|authorization.?header)/i;
const FORBIDDEN_VALUE = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|seed phrase|mnemonic phrase|bearer\s+[A-Za-z0-9._-]{12,})/i;
const MAX_HEARTBEAT_AGE_MS = 15 * 60 * 1000;

function fail(message) {
  throw new Error(`Production deployment evidence invalid: ${message}`);
}
function requireValue(condition, message) {
  if (!condition) fail(message);
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, label, minLength = 1) {
  requireValue(typeof value === "string" && value.trim().length >= minLength, `${label} is required.`);
  const text = value.trim();
  requireValue(!FORBIDDEN_TEXT.test(text), `${label} contains placeholder text.`);
  requireValue(!FORBIDDEN_VALUE.test(text), `${label} appears to contain secret material.`);
  return text;
}
function isoDate(value, label) {
  const text = cleanText(value, label);
  const millis = Date.parse(text);
  requireValue(Number.isFinite(millis), `${label} must be an ISO-8601 timestamp.`);
  return { text, millis };
}
function httpsUrl(value, label) {
  const text = cleanText(value, label);
  let parsed;
  try { parsed = new URL(text); } catch { fail(`${label} must be a valid URL.`); }
  requireValue(parsed.protocol === "https:", `${label} must use https.`);
  requireValue(!parsed.username && !parsed.password, `${label} must not contain URL credentials.`);
  return text;
}
function hash32(value, label) {
  requireValue(typeof value === "string" && HEX_32.test(value), `${label} must be a 32-byte 0x-prefixed hash.`);
  requireValue(!/^0x0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function address(value, label) {
  requireValue(typeof value === "string" && HEX_20.test(value), `${label} must be an EVM address.`);
  requireValue(!/^0x0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function nodeId(value, label) {
  requireValue(typeof value === "string" && NODE_ID.test(value), `${label} must be a 64-byte 0x-prefixed validator node identifier.`);
  requireValue(!/^0x0{128}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function sha256(value, label) {
  requireValue(typeof value === "string" && SHA256.test(value), `${label} must be a 64-character SHA-256 digest.`);
  requireValue(!/^0{64}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function gitSha(value, label) {
  requireValue(typeof value === "string" && GIT_SHA.test(value), `${label} must be a full 40-character Git SHA.`);
  requireValue(!/^0{40}$/i.test(value), `${label} must not be zero.`);
  return value.toLowerCase();
}
function decimal(value, label) {
  requireValue(typeof value === "string" && DECIMAL.test(value), `${label} must be a non-negative decimal string.`);
  return BigInt(value);
}
function opaqueId(value, label) {
  const text = cleanText(value, label, 3);
  requireValue(OPAQUE_ID.test(text), `${label} must be a non-secret opaque identifier.`);
  return text;
}
function evidenceRef(value, label) {
  requireValue(isRecord(value), `${label} is required.`);
  return {
    url: httpsUrl(value.url, `${label}.url`),
    sha256: sha256(value.sha256, `${label}.sha256`),
  };
}
function scanUnsafe(value, objectPath = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafe(item, `${objectPath}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireValue(!FORBIDDEN_KEY.test(key), `${objectPath}.${key} is a forbidden secret-bearing field name.`);
      scanUnsafe(child, `${objectPath}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    requireValue(!FORBIDDEN_TEXT.test(value), `${objectPath} contains placeholder text.`);
    requireValue(!FORBIDDEN_VALUE.test(value), `${objectPath} appears to contain secret material.`);
  }
}

function expectedContractMap(value) {
  if (value === undefined) return undefined;
  requireValue(Array.isArray(value), "expected contracts must be an array.");
  const map = new Map();
  for (const contract of value) {
    requireValue(isRecord(contract), "expected contract entry must be an object.");
    const name = cleanText(contract.name, "expected contract name");
    requireValue(!map.has(name), `expected contract ${name} is duplicated.`);
    map.set(name, {
      address: address(contract.address, `expected contract ${name}.address`),
      runtimeCodeHash: hash32(contract.runtimeCodeHash, `expected contract ${name}.runtimeCodeHash`),
    });
  }
  return map;
}

function expectedVerifierMap(value) {
  if (value === undefined) return undefined;
  requireValue(isRecord(value), "expected verifiers must be an object.");
  const map = new Map();
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const verifier = value[key];
    requireValue(isRecord(verifier), `expected verifier ${key} is required.`);
    map.set(key, {
      address: address(verifier.address, `expected verifier ${key}.address`),
      runtimeCodeHash: hash32(verifier.runtimeCodeHash, `expected verifier ${key}.runtimeCodeHash`),
      circuitArtifactHash: hash32(verifier.circuitArtifactHash, `expected verifier ${key}.circuitArtifactHash`),
      verificationKeyHash: hash32(verifier.verificationKeyHash, `expected verifier ${key}.verificationKeyHash`),
      buildAttestationSha256: hash32(verifier.buildAttestationSha256, `expected verifier ${key}.buildAttestationSha256`),
      ceremonyEvidenceSha256: hash32(verifier.ceremonyEvidenceSha256, `expected verifier ${key}.ceremonyEvidenceSha256`),
    });
  }
  return map;
}

export function validateProductionDeploymentEvidence(evidence, expected = {}) {
  requireValue(isRecord(evidence), "evidence must be a JSON object.");
  scanUnsafe(evidence);
  requireValue(evidence.format === DEPLOYMENT_FORMAT, `format must equal ${DEPLOYMENT_FORMAT}.`);
  requireValue(evidence.result === "pass", "result must equal pass.");
  requireValue(evidence.environment === "production", "environment must equal production.");
  requireValue(evidence.networkType === "persistent-consortium", "networkType must equal persistent-consortium.");

  const releaseVersion = cleanText(evidence.releaseVersion, "releaseVersion");
  requireValue(VERSION.test(releaseVersion), "releaseVersion must be semantic version text such as v1.0.0.");
  if (expected.releaseVersion !== undefined) requireValue(releaseVersion === expected.releaseVersion, "releaseVersion does not match the release manifest.");
  const sourceDevelopCommit = gitSha(evidence.sourceDevelopCommit, "sourceDevelopCommit");
  if (expected.sourceDevelopCommit !== undefined) {
    requireValue(sourceDevelopCommit === gitSha(expected.sourceDevelopCommit, "expected sourceDevelopCommit"), "sourceDevelopCommit does not match the release source commit.");
  }
  const observedAt = isoDate(evidence.observedAt, "observedAt");
  if (expected.preparedAt !== undefined) {
    const preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(observedAt.millis <= preparedAt.millis, "observedAt must not be after release.preparedAt.");
  }

  requireValue(isRecord(evidence.chain), "chain section is required.");
  const networkName = cleanText(evidence.chain.networkName, "chain.networkName", 5);
  if (expected.networkName !== undefined) requireValue(networkName === expected.networkName, "chain.networkName does not match the release manifest.");
  requireValue(evidence.chain.chainId === 2026, "chain.chainId must equal 2026.");
  if (expected.chainId !== undefined) requireValue(evidence.chain.chainId === expected.chainId, "chain.chainId does not match the release manifest.");
  const genesisHash = hash32(evidence.chain.genesisHash, "chain.genesisHash");
  if (expected.genesisHash !== undefined) requireValue(genesisHash === hash32(expected.genesisHash, "expected genesisHash"), "chain.genesisHash does not match the release manifest.");
  requireValue(Number.isInteger(evidence.chain.validatorCount) && evidence.chain.validatorCount >= 5, "chain.validatorCount must be at least 5.");
  if (expected.validatorCount !== undefined) requireValue(evidence.chain.validatorCount === expected.validatorCount, "chain.validatorCount does not match the release manifest.");

  requireValue(Array.isArray(evidence.validators), "validators must be an array.");
  requireValue(evidence.validators.length === evidence.chain.validatorCount, "validators length must equal chain.validatorCount.");
  const validatorIds = new Set();
  const validatorAddresses = new Set();
  const validatorNodeIds = new Set();
  const organizations = new Set();
  const adminDomains = new Set();
  for (let index = 0; index < evidence.validators.length; index += 1) {
    const validator = evidence.validators[index];
    const label = `validators[${index}]`;
    requireValue(isRecord(validator), `${label} must be an object.`);
    const id = opaqueId(validator.validatorId, `${label}.validatorId`);
    requireValue(!validatorIds.has(id), `${label}.validatorId is duplicated.`);
    validatorIds.add(id);
    const organizationId = hash32(validator.organizationId, `${label}.organizationId`);
    requireValue(!organizations.has(organizationId), `${label}.organizationId is not administratively distinct.`);
    organizations.add(organizationId);
    const validatorAddress = address(validator.validatorAddress, `${label}.validatorAddress`);
    requireValue(!validatorAddresses.has(validatorAddress), `${label}.validatorAddress is duplicated.`);
    validatorAddresses.add(validatorAddress);
    const validatorNodeId = nodeId(validator.nodeId, `${label}.nodeId`);
    requireValue(!validatorNodeIds.has(validatorNodeId), `${label}.nodeId is duplicated.`);
    validatorNodeIds.add(validatorNodeId);
    const administrativeDomain = cleanText(validator.administrativeDomain, `${label}.administrativeDomain`, 3).toLowerCase();
    requireValue(DOMAIN_ID.test(administrativeDomain), `${label}.administrativeDomain must be an opaque lowercase administration-domain identifier.`);
    requireValue(!adminDomains.has(administrativeDomain), `${label}.administrativeDomain is not distinct.`);
    adminDomains.add(administrativeDomain);
    for (const key of ["persistentStorage", "privateNetworking", "tlsEnabled", "nodePermissioning", "monitoringEnabled"]) {
      requireValue(validator[key] === true, `${label}.${key} must be true.`);
    }
    evidenceRef(validator.evidence, `${label}.evidence`);
  }
  requireValue(adminDomains.size >= 5, "deployment must declare at least five distinct validator administrative domains.");

  requireValue(isRecord(evidence.networkControls), "networkControls section is required.");
  for (const key of ["privateNetworking", "tlsRequired", "nodePermissioning", "accountPermissioning", "persistentStorage", "monitoring", "backupsConfigured"]) {
    requireValue(evidence.networkControls[key] === true, `networkControls.${key} must be true.`);
  }
  evidenceRef(evidence.networkControls.evidence, "networkControls.evidence");

  requireValue(isRecord(evidence.signing), "signing section is required.");
  requireValue(evidence.signing.mode === "remote-web3signer", "signing.mode must equal remote-web3signer.");
  requireValue(evidence.signing.kmsOrHsmBacked === true, "signing.kmsOrHsmBacked must be true.");
  requireValue(evidence.signing.web3SignerTls === true, "signing.web3SignerTls must be true.");
  requireValue(evidence.signing.localPrivateKeysDisabled === true, "signing.localPrivateKeysDisabled must be true.");
  cleanText(evidence.signing.keyCustodyDescription, "signing.keyCustodyDescription", 16);
  evidenceRef(evidence.signing.evidence, "signing.evidence");
  if (expected.signerMode !== undefined) requireValue(evidence.signing.mode === expected.signerMode, "signing.mode does not match the release manifest.");
  if (expected.kmsOrHsmBacked !== undefined) requireValue(evidence.signing.kmsOrHsmBacked === expected.kmsOrHsmBacked, "signing.kmsOrHsmBacked does not match the release manifest.");

  const expectedContracts = expectedContractMap(expected.contracts);
  requireValue(Array.isArray(evidence.contracts), "contracts must be an array.");
  requireValue(evidence.contracts.length === REQUIRED_CONTRACTS.length, "contracts must contain exactly the required ThreadProof state contracts.");
  const seenContracts = new Set();
  for (let index = 0; index < evidence.contracts.length; index += 1) {
    const contract = evidence.contracts[index];
    const label = `contracts[${index}]`;
    requireValue(isRecord(contract), `${label} must be an object.`);
    const name = cleanText(contract.name, `${label}.name`);
    requireValue(REQUIRED_CONTRACTS.includes(name), `${label}.name ${name} is not a required ThreadProof contract.`);
    requireValue(!seenContracts.has(name), `contract ${name} is duplicated.`);
    seenContracts.add(name);
    const contractAddress = address(contract.address, `${label}.address`);
    const runtimeCodeHash = hash32(contract.runtimeCodeHash, `${label}.runtimeCodeHash`);
    if (expectedContracts) {
      const expectedContract = expectedContracts.get(name);
      requireValue(Boolean(expectedContract), `release manifest is missing contract ${name}.`);
      requireValue(contractAddress === expectedContract.address, `${label}.address does not match the release manifest.`);
      requireValue(runtimeCodeHash === expectedContract.runtimeCodeHash, `${label}.runtimeCodeHash does not match the release manifest.`);
    }
  }
  for (const name of REQUIRED_CONTRACTS) requireValue(seenContracts.has(name), `required contract ${name} is missing.`);

  const expectedVerifiers = expectedVerifierMap(expected.verifiers);
  requireValue(isRecord(evidence.verifiers), "verifiers section is required.");
  for (const key of ["capacitySpend", "capacityRelease"]) {
    const verifier = evidence.verifiers[key];
    const label = `verifiers.${key}`;
    requireValue(isRecord(verifier), `${label} is required.`);
    const actual = {
      address: address(verifier.address, `${label}.address`),
      runtimeCodeHash: hash32(verifier.runtimeCodeHash, `${label}.runtimeCodeHash`),
      circuitArtifactHash: hash32(verifier.circuitArtifactHash, `${label}.circuitArtifactHash`),
      verificationKeyHash: hash32(verifier.verificationKeyHash, `${label}.verificationKeyHash`),
      buildAttestationSha256: hash32(verifier.buildAttestationSha256, `${label}.buildAttestationSha256`),
      ceremonyEvidenceSha256: hash32(verifier.ceremonyEvidenceSha256, `${label}.ceremonyEvidenceSha256`),
    };
    if (expectedVerifiers) {
      const wanted = expectedVerifiers.get(key);
      for (const [field, value] of Object.entries(actual)) {
        requireValue(value === wanted[field], `${label}.${field} does not match the release manifest.`);
      }
    }
  }
  requireValue(Object.keys(evidence.verifiers).every((key) => ["capacitySpend", "capacityRelease"].includes(key)), "verifiers contains an unsupported verifier key.");

  requireValue(Array.isArray(evidence.services), "services must be an array.");
  const services = new Map();
  for (let index = 0; index < evidence.services.length; index += 1) {
    const service = evidence.services[index];
    const label = `services[${index}]`;
    requireValue(isRecord(service), `${label} must be an object.`);
    const serviceId = cleanText(service.serviceId, `${label}.serviceId`);
    requireValue(REQUIRED_SERVICES.includes(serviceId), `${label}.serviceId ${serviceId} is not a required production service.`);
    requireValue(!services.has(serviceId), `service ${serviceId} is duplicated.`);
    requireValue(service.status === "healthy", `${label}.status must equal healthy.`);
    requireValue(service.chainId === 2026, `${label}.chainId must equal 2026.`);
    const heartbeatAt = isoDate(service.heartbeatAt, `${label}.heartbeatAt`);
    requireValue(heartbeatAt.millis <= observedAt.millis, `${label}.heartbeatAt must not be after observedAt.`);
    requireValue(observedAt.millis - heartbeatAt.millis <= MAX_HEARTBEAT_AGE_MS, `${label}.heartbeatAt is older than 15 minutes at observedAt.`);
    evidenceRef(service.evidence, `${label}.evidence`);
    services.set(serviceId, service);
  }
  for (const required of REQUIRED_SERVICES) requireValue(services.has(required), `required production service ${required} is missing.`);
  requireValue(services.size === REQUIRED_SERVICES.length, "services must contain exactly the required production service set.");

  const indexer = services.get("event_indexer");
  requireValue(isRecord(indexer.canonicalCursor), "event_indexer.canonicalCursor is required.");
  const cursorBlock = decimal(indexer.canonicalCursor.blockNumber, "event_indexer.canonicalCursor.blockNumber");
  requireValue(cursorBlock > 0n, "event_indexer canonical cursor block must be positive.");
  hash32(indexer.canonicalCursor.blockHash, "event_indexer.canonicalCursor.blockHash");
  const headBlock = decimal(indexer.canonicalCursor.observedHeadBlock, "event_indexer.canonicalCursor.observedHeadBlock");
  requireValue(headBlock >= cursorBlock, "event_indexer observed head must not be behind the canonical cursor.");
  hash32(indexer.canonicalCursor.observedHeadBlockHash, "event_indexer.canonicalCursor.observedHeadBlockHash");
  requireValue(Number.isInteger(indexer.canonicalCursor.confirmationDepth) && indexer.canonicalCursor.confirmationDepth >= 1, "event_indexer.canonicalCursor.confirmationDepth must be at least 1.");
  requireValue(indexer.canonicalCursor.reorgQuarantineEnabled === true, "event_indexer.canonicalCursor.reorgQuarantineEnabled must be true.");

  requireValue(isRecord(evidence.signoff), "signoff section is required.");
  const executedBy = opaqueId(evidence.signoff.executedBy, "signoff.executedBy");
  requireValue(Array.isArray(evidence.signoff.reviewerIds) && evidence.signoff.reviewerIds.length >= 2, "signoff.reviewerIds must contain at least two reviewers.");
  const reviewerIds = new Set();
  for (const reviewer of evidence.signoff.reviewerIds) {
    const reviewerId = opaqueId(reviewer, "signoff.reviewerIds[]");
    requireValue(!reviewerIds.has(reviewerId), `signoff reviewer ${reviewerId} is duplicated.`);
    reviewerIds.add(reviewerId);
  }
  requireValue(!reviewerIds.has(executedBy) || reviewerIds.size >= 3, "deployment evidence should not rely only on the executor reviewing their own evidence.");
  const approvedAt = isoDate(evidence.signoff.approvedAt, "signoff.approvedAt");
  requireValue(approvedAt.millis >= observedAt.millis, "signoff.approvedAt must not predate observedAt.");
  if (expected.preparedAt !== undefined) {
    const preparedAt = isoDate(expected.preparedAt, "expected release preparedAt");
    requireValue(approvedAt.millis <= preparedAt.millis, "signoff.approvedAt must not be after release.preparedAt.");
  }
  cleanText(evidence.signoff.statement, "signoff.statement", 24);

  return {
    format: evidence.format,
    result: evidence.result,
    releaseVersion,
    sourceDevelopCommit,
    chainId: evidence.chain.chainId,
    validatorCount: evidence.validators.length,
    administrativeDomainCount: adminDomains.size,
    contractCount: seenContracts.size,
    serviceCount: services.size,
    observedAt: observedAt.text,
  };
}

export async function loadAndValidateProductionDeploymentEvidence(filePath, expected = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`could not read valid JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateProductionDeploymentEvidence(parsed, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidencePath = process.argv[2] ?? process.env.THREADPROOF_DEPLOYMENT_EVIDENCE_PATH;
  if (!evidencePath) {
    console.error("Usage: node scripts/production-deployment-evidence.mjs <deployment-evidence.json>");
    process.exit(2);
  }
  loadAndValidateProductionDeploymentEvidence(evidencePath, {
    releaseVersion: process.env.THREADPROOF_EXPECTED_RELEASE_VERSION,
    sourceDevelopCommit: process.env.THREADPROOF_EXPECTED_SOURCE_COMMIT,
    networkName: process.env.THREADPROOF_EXPECTED_NETWORK_NAME,
    chainId: process.env.THREADPROOF_EXPECTED_CHAIN_ID ? Number(process.env.THREADPROOF_EXPECTED_CHAIN_ID) : undefined,
    genesisHash: process.env.THREADPROOF_EXPECTED_GENESIS_HASH,
    validatorCount: process.env.THREADPROOF_EXPECTED_VALIDATOR_COUNT ? Number(process.env.THREADPROOF_EXPECTED_VALIDATOR_COUNT) : undefined,
    signerMode: process.env.THREADPROOF_EXPECTED_SIGNER_MODE,
    kmsOrHsmBacked: process.env.THREADPROOF_EXPECTED_KMS_HSM === undefined ? undefined : process.env.THREADPROOF_EXPECTED_KMS_HSM === "true",
    preparedAt: process.env.THREADPROOF_EXPECTED_PREPARED_AT,
  }).then((summary) => {
    console.log(`Production deployment evidence verified: ${JSON.stringify(summary)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
