import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

type ContractManifestEntry = {
  name: string;
  address: string;
  runtimeCodeHash: string;
};

type VerifierManifestEntry = {
  circuitVersion: number;
  address: string;
  circuitArtifactHash: string;
  verificationKeyHash: string;
  runtimeCodeHash: string;
  buildAttestationSha256: string;
  setup: string;
  ceremonyEvidenceSha256: string;
};

type ReleaseManifest = {
  schemaVersion: number;
  release: {
    version: string;
    sourceDevelopCommit: string;
  };
  chain: {
    networkName: string;
    chainId: number;
    genesisHash: string;
    validatorCount: number;
  };
  contracts: ContractManifestEntry[];
  verifiers: {
    capacitySpend: VerifierManifestEntry;
    capacityRelease: VerifierManifestEntry;
  };
  evidence: {
    verifierGovernanceEvidenceSha256: string;
  };
};

type RpcBlock = {
  hash?: string | null;
  timestamp?: string;
};

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
};

type RpcReceipt = {
  transactionHash?: string;
  blockHash?: string;
  blockNumber?: string;
  status?: string;
  from?: string;
  to?: string | null;
  logs?: RpcLog[];
};

type VerifierProvenance = {
  verifier: string;
  circuitArtifactHash: string;
  verificationKeyHash: string;
  verifierCodeHash: string;
  registeredAt: bigint;
};

type GovernanceExecution = {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  executedAt: string;
  executorAddress: string;
};

type GovernanceRegistration = {
  proposalId: string;
  proposalType: string;
  proposalTypeCode: number;
  actionHash: string;
  circuitVersion: number;
  verifierAddress: string;
  circuitArtifactHash: string;
  verificationKeyHash: string;
  proposalState: string;
  policyVersion: number;
  approvalsReceived: number;
  approvalsRequired: number;
  eligibleMask: number;
  requiredMask: number;
  approvalMask: number;
  timelockSeconds: number;
  approvedAt: string;
  executeAfter: string;
  execution: GovernanceExecution;
};

type VerifierGovernanceEvidence = {
  format: string;
  result: string;
  environment: string;
  releaseVersion: string;
  sourceDevelopCommit: string;
  observedAt: string;
  chain: {
    chainId: number;
    genesisHash: string;
  };
  contracts: {
    capacityVault: string;
    threadProofCharter: string;
  };
  registrations: {
    capacitySpend: GovernanceRegistration;
    capacityRelease: GovernanceRegistration;
  };
};

const REQUIRED_ROLE_MASK = 0x0c; // Auditor | Regulator.
const MIN_VERIFIER_APPROVALS = 4;
const MIN_VERIFIER_TIMELOCK_SECONDS = 24 * 60 * 60;
const GOVERNANCE_FORMAT = "threadproof-production-verifier-governance/v1";
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/i;

const provenanceInterface = new ethers.Interface([
  "function getVerifierProvenance(uint32 circuitVersion) view returns (tuple(address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt))",
  "function getReleaseVerifierProvenance(uint32 circuitVersion) view returns (tuple(address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt))",
]);
const verifierEvidenceInterface = new ethers.Interface([
  "function buildAttestationSha256() view returns (bytes32)",
  "function ceremonyEvidenceSha256() view returns (bytes32)",
]);
const charterInterface = new ethers.Interface([
  "function getProposal(bytes32 proposalId) view returns (tuple(bytes32 id,uint8 proposalType,bytes32 proposerOrganizationId,bytes32 actionHash,bytes32 metadataHash,uint64 policyVersion,uint64 createdAt,uint64 expiresAt,uint64 approvedAt,uint64 executeAfter,uint8 approvalsReceived,uint8 approvalsRequired,uint8 eligibleMask,uint8 requiredMask,uint8 approvalMask,uint64 timelockSeconds,bool executed,bool cancelled))",
  "function getProposalState(bytes32 proposalId) view returns (uint8)",
  "function hashVerifierRegistrationAction(uint32 circuitVersion,address verifierAddress,bytes32 circuitArtifactHash,bytes32 verificationKeyHash) view returns (bytes32)",
  "function hashReleaseVerifierRegistrationAction(uint32 circuitVersion,address verifierAddress,bytes32 circuitArtifactHash,bytes32 verificationKeyHash) view returns (bytes32)",
  "event ProposalExecuted(bytes32 indexed proposalId,uint8 indexed proposalType,address indexed executor)",
  "event VerifierRegistrationAuthorized(bytes32 indexed proposalId,uint32 indexed circuitVersion,address indexed verifier,bytes32 circuitArtifactHash,bytes32 verificationKeyHash)",
  "event ReleaseVerifierRegistrationAuthorized(bytes32 indexed proposalId,uint32 indexed circuitVersion,address indexed verifier,bytes32 circuitArtifactHash,bytes32 verificationKeyHash)",
]);
const vaultEventInterface = new ethers.Interface([
  "event VerifierProvenanceRegistered(uint32 indexed circuitVersion,address indexed verifier,bytes32 indexed circuitArtifactHash,bytes32 verificationKeyHash,bytes32 verifierCodeHash)",
  "event ReleaseVerifierProvenanceRegistered(uint32 indexed circuitVersion,address indexed verifier,bytes32 indexed circuitArtifactHash,bytes32 verificationKeyHash,bytes32 verifierCodeHash)",
]);

function fail(message: string): never {
  throw new Error(`Production deployment verification failed: ${message}`);
}

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function requireEqual(actual: string, expected: string, label: string) {
  if (!sameHex(actual, expected)) fail(`${label} mismatch: expected ${expected}, got ${actual}`);
}

function requireNumber(actual: bigint | number, expected: number, label: string) {
  if (Number(actual) !== expected) fail(`${label} mismatch: expected ${expected}, got ${String(actual)}`);
}

function requireUnixTimestamp(iso: string, seconds: bigint, label: string) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) fail(`${label} is not a valid timestamp: ${iso}`);
  if (parsed !== Number(seconds) * 1000) {
    fail(`${label} mismatch: evidence ${iso}, chain ${new Date(Number(seconds) * 1000).toISOString()}`);
  }
}

async function rpc<T>(method: string, params: unknown[] = []) {
  return (await network.provider.send(method, params)) as T;
}

async function runtimeCodeHash(address: string, label: string) {
  const code = await rpc<string>("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") fail(`${label} has no deployed runtime bytecode at ${address}`);
  return ethers.keccak256(code);
}

async function verifierEvidenceHash(
  address: string,
  functionName: "buildAttestationSha256" | "ceremonyEvidenceSha256",
) {
  const data = verifierEvidenceInterface.encodeFunctionData(functionName);
  const result = await rpc<string>("eth_call", [{ to: address, data }, "latest"]);
  const decoded = verifierEvidenceInterface.decodeFunctionResult(functionName, result);
  const value = decoded[0];
  if (!value) fail(`verifier ${address} returned no ${functionName} value.`);
  return String(value);
}

async function verifierProvenance(
  vaultAddress: string,
  functionName: "getVerifierProvenance" | "getReleaseVerifierProvenance",
  circuitVersion: number,
): Promise<VerifierProvenance> {
  const data = provenanceInterface.encodeFunctionData(functionName, [circuitVersion]);
  const result = await rpc<string>("eth_call", [{ to: vaultAddress, data }, "latest"]);
  const decoded = provenanceInterface.decodeFunctionResult(functionName, result);
  const tuple = decoded[0];
  if (!tuple) fail(`${functionName} returned no provenance tuple.`);

  return {
    verifier: String(tuple.verifier),
    circuitArtifactHash: String(tuple.circuitArtifactHash),
    verificationKeyHash: String(tuple.verificationKeyHash),
    verifierCodeHash: String(tuple.verifierCodeHash),
    registeredAt: BigInt(tuple.registeredAt),
  };
}

function loadManifest() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const manifestPath = path.resolve(
    repoRoot,
    process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json",
  );
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as ReleaseManifest;
  return {
    repoRoot,
    manifest,
    manifestPath,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function loadGovernanceEvidence(repoRoot: string, manifest: ReleaseManifest) {
  if (!RELEASE_VERSION.test(manifest.release.version)) fail("release version cannot derive governance evidence path.");
  const expectedSha = String(manifest.evidence?.verifierGovernanceEvidenceSha256 ?? "").toLowerCase();
  if (!SHA256.test(expectedSha) || /^0{64}$/.test(expectedSha)) {
    fail("manifest verifier-governance evidence SHA-256 is invalid.");
  }
  const evidencePath = path.resolve(
    repoRoot,
    `docs/releases/${manifest.release.version}/verifier-governance-evidence.json`,
  );
  const releasesRoot = path.join(repoRoot, "docs", "releases");
  if (!evidencePath.startsWith(`${releasesRoot}${path.sep}`)) fail("governance evidence path escapes docs/releases.");
  const raw = readFileSync(evidencePath);
  const actualSha = createHash("sha256").update(raw).digest("hex");
  if (actualSha !== expectedSha) {
    fail(`verifier-governance evidence SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}.`);
  }
  const evidence = JSON.parse(raw.toString("utf8")) as VerifierGovernanceEvidence;
  return { evidence, evidencePath, evidenceSha256: actualSha };
}

async function verifyVerifier(
  kind: "capacitySpend" | "capacityRelease",
  verifier: VerifierManifestEntry,
  vaultAddress: string,
  functionName: "getVerifierProvenance" | "getReleaseVerifierProvenance",
) {
  if (verifier.setup !== "production-ceremony") fail(`${kind} verifier is not marked as production-ceremony.`);
  if (!ethers.isAddress(verifier.address)) fail(`${kind} verifier address is invalid.`);
  if (!/^0x[0-9a-f]{64}$/i.test(verifier.buildAttestationSha256)) {
    fail(`${kind} build attestation SHA-256 is invalid.`);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(verifier.ceremonyEvidenceSha256)) {
    fail(`${kind} ceremony evidence SHA-256 is invalid.`);
  }

  const actualVerifierCodeHash = await runtimeCodeHash(verifier.address, `${kind} verifier`);
  requireEqual(actualVerifierCodeHash, verifier.runtimeCodeHash, `${kind} verifier runtime code hash`);

  const actualBuildAttestationSha256 = await verifierEvidenceHash(verifier.address, "buildAttestationSha256");
  requireEqual(
    actualBuildAttestationSha256,
    verifier.buildAttestationSha256,
    `${kind} build attestation SHA-256`,
  );

  const actualCeremonyEvidenceSha256 = await verifierEvidenceHash(verifier.address, "ceremonyEvidenceSha256");
  requireEqual(
    actualCeremonyEvidenceSha256,
    verifier.ceremonyEvidenceSha256,
    `${kind} ceremony evidence SHA-256`,
  );

  const provenance = await verifierProvenance(vaultAddress, functionName, verifier.circuitVersion);
  requireEqual(provenance.verifier, verifier.address, `${kind} provenance verifier address`);
  requireEqual(provenance.circuitArtifactHash, verifier.circuitArtifactHash, `${kind} circuit artifact hash`);
  requireEqual(provenance.verificationKeyHash, verifier.verificationKeyHash, `${kind} verification key hash`);
  requireEqual(provenance.verifierCodeHash, verifier.runtimeCodeHash, `${kind} registered verifier code hash`);

  return {
    circuitVersion: verifier.circuitVersion,
    address: verifier.address,
    runtimeCodeHash: actualVerifierCodeHash,
    circuitArtifactHash: provenance.circuitArtifactHash,
    verificationKeyHash: provenance.verificationKeyHash,
    buildAttestationSha256: actualBuildAttestationSha256,
    ceremonyEvidenceSha256: actualCeremonyEvidenceSha256,
    registeredAt: provenance.registeredAt.toString(),
  };
}

async function charterCall(charterAddress: string, functionName: string, args: unknown[] = []) {
  const data = charterInterface.encodeFunctionData(functionName, args);
  const result = await rpc<string>("eth_call", [{ to: charterAddress, data }, "latest"]);
  return charterInterface.decodeFunctionResult(functionName, result);
}

function matchingParsedLog(
  logs: RpcLog[],
  address: string,
  iface: ethers.Interface,
  eventName: string,
  predicate: (args: ethers.Result) => boolean,
) {
  for (const log of logs) {
    if (!sameHex(log.address, address)) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === eventName && predicate(parsed.args)) return true;
    } catch {
      // Ignore unrelated logs from the same contract.
    }
  }
  return false;
}

async function verifyGovernedRegistration(
  kind: "capacitySpend" | "capacityRelease",
  registration: GovernanceRegistration,
  verifier: VerifierManifestEntry,
  charterAddress: string,
  vaultAddress: string,
) {
  const releaseRegistration = kind === "capacityRelease";
  const expectedProposalType = releaseRegistration ? 14 : 8;
  const expectedProposalName = releaseRegistration ? "ReleaseVerifierRegistration" : "VerifierRegistration";
  const actionFunction = releaseRegistration
    ? "hashReleaseVerifierRegistrationAction"
    : "hashVerifierRegistrationAction";
  const authorizedEvent = releaseRegistration
    ? "ReleaseVerifierRegistrationAuthorized"
    : "VerifierRegistrationAuthorized";
  const vaultEvent = releaseRegistration
    ? "ReleaseVerifierProvenanceRegistered"
    : "VerifierProvenanceRegistered";

  if (registration.proposalType !== expectedProposalName || registration.proposalTypeCode !== expectedProposalType) {
    fail(`${kind} evidence has the wrong Charter proposal type.`);
  }
  if (registration.proposalState !== "executed") fail(`${kind} Charter proposal is not marked executed.`);
  requireNumber(registration.circuitVersion, verifier.circuitVersion, `${kind} governance circuit version`);
  requireEqual(registration.verifierAddress, verifier.address, `${kind} governed verifier address`);
  requireEqual(registration.circuitArtifactHash, verifier.circuitArtifactHash, `${kind} governed circuit artifact hash`);
  requireEqual(registration.verificationKeyHash, verifier.verificationKeyHash, `${kind} governed verification key hash`);

  const actionResult = await charterCall(charterAddress, actionFunction, [
    verifier.circuitVersion,
    verifier.address,
    verifier.circuitArtifactHash,
    verifier.verificationKeyHash,
  ]);
  const canonicalActionHash = String(actionResult[0]);
  requireEqual(registration.actionHash, canonicalActionHash, `${kind} Charter action hash`);

  const proposalResult = await charterCall(charterAddress, "getProposal", [registration.proposalId]);
  const proposal = proposalResult[0];
  if (!proposal) fail(`${kind} Charter proposal was not returned.`);
  requireEqual(String(proposal.id), registration.proposalId, `${kind} proposal id`);
  requireNumber(BigInt(proposal.proposalType), expectedProposalType, `${kind} proposal type`);
  requireEqual(String(proposal.actionHash), canonicalActionHash, `${kind} proposal action hash`);
  requireNumber(BigInt(proposal.policyVersion), registration.policyVersion, `${kind} proposal policy version`);
  requireNumber(BigInt(proposal.approvalsReceived), registration.approvalsReceived, `${kind} approvals received`);
  requireNumber(BigInt(proposal.approvalsRequired), registration.approvalsRequired, `${kind} approvals required`);
  requireNumber(BigInt(proposal.eligibleMask), registration.eligibleMask, `${kind} eligible mask`);
  requireNumber(BigInt(proposal.requiredMask), registration.requiredMask, `${kind} required mask`);
  requireNumber(BigInt(proposal.approvalMask), registration.approvalMask, `${kind} approval mask`);
  requireNumber(BigInt(proposal.timelockSeconds), registration.timelockSeconds, `${kind} timelock seconds`);
  requireUnixTimestamp(registration.approvedAt, BigInt(proposal.approvedAt), `${kind} approvedAt`);
  requireUnixTimestamp(registration.executeAfter, BigInt(proposal.executeAfter), `${kind} executeAfter`);
  if (!proposal.executed || proposal.cancelled) fail(`${kind} proposal is not an executed, non-cancelled Charter action.`);

  const stateResult = await charterCall(charterAddress, "getProposalState", [registration.proposalId]);
  requireNumber(BigInt(stateResult[0]), 4, `${kind} proposal state`);
  if (registration.approvalsRequired < MIN_VERIFIER_APPROVALS) fail(`${kind} verifier governance threshold is below 4.`);
  if ((registration.requiredMask & REQUIRED_ROLE_MASK) !== REQUIRED_ROLE_MASK) {
    fail(`${kind} verifier governance does not require Auditor and Regulator.`);
  }
  if ((registration.approvalMask & REQUIRED_ROLE_MASK) !== REQUIRED_ROLE_MASK) {
    fail(`${kind} verifier governance lacks Auditor and Regulator approvals.`);
  }
  if (registration.timelockSeconds < MIN_VERIFIER_TIMELOCK_SECONDS) {
    fail(`${kind} verifier governance timelock is below 24 hours.`);
  }

  const receipt = await rpc<RpcReceipt>("eth_getTransactionReceipt", [registration.execution.txHash]);
  if (!receipt?.transactionHash) fail(`${kind} execution transaction receipt is unavailable.`);
  requireEqual(receipt.transactionHash, registration.execution.txHash, `${kind} execution transaction hash`);
  if (receipt.status !== "0x1") fail(`${kind} Charter execution transaction did not succeed.`);
  if (!receipt.to || !sameHex(receipt.to, charterAddress)) fail(`${kind} execution transaction did not target ThreadProofCharter.`);
  if (!receipt.from) fail(`${kind} execution transaction has no sender.`);
  requireEqual(receipt.from, registration.execution.executorAddress, `${kind} execution sender`);
  if (!receipt.blockHash || !receipt.blockNumber) fail(`${kind} execution receipt lacks canonical block identity.`);
  requireEqual(receipt.blockHash, registration.execution.blockHash, `${kind} execution block hash`);
  requireNumber(BigInt(receipt.blockNumber), registration.execution.blockNumber, `${kind} execution block number`);

  const block = await rpc<RpcBlock>("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!block?.hash || !block.timestamp) fail(`${kind} execution block is unavailable.`);
  requireEqual(block.hash, registration.execution.blockHash, `${kind} canonical execution block hash`);
  requireUnixTimestamp(registration.execution.executedAt, BigInt(block.timestamp), `${kind} execution block timestamp`);

  const logs = receipt.logs ?? [];
  const hasProposalExecuted = matchingParsedLog(
    logs,
    charterAddress,
    charterInterface,
    "ProposalExecuted",
    (args) => sameHex(String(args.proposalId), registration.proposalId)
      && Number(args.proposalType) === expectedProposalType
      && sameHex(String(args.executor), registration.execution.executorAddress),
  );
  if (!hasProposalExecuted) fail(`${kind} execution receipt lacks matching Charter ProposalExecuted log.`);

  const hasAuthorization = matchingParsedLog(
    logs,
    charterAddress,
    charterInterface,
    authorizedEvent,
    (args) => sameHex(String(args.proposalId), registration.proposalId)
      && Number(args.circuitVersion) === verifier.circuitVersion
      && sameHex(String(args.verifier), verifier.address)
      && sameHex(String(args.circuitArtifactHash), verifier.circuitArtifactHash)
      && sameHex(String(args.verificationKeyHash), verifier.verificationKeyHash),
  );
  if (!hasAuthorization) fail(`${kind} execution receipt lacks matching Charter verifier-authorization log.`);

  const hasVaultRegistration = matchingParsedLog(
    logs,
    vaultAddress,
    vaultEventInterface,
    vaultEvent,
    (args) => Number(args.circuitVersion) === verifier.circuitVersion
      && sameHex(String(args.verifier), verifier.address)
      && sameHex(String(args.circuitArtifactHash), verifier.circuitArtifactHash)
      && sameHex(String(args.verificationKeyHash), verifier.verificationKeyHash)
      && sameHex(String(args.verifierCodeHash), verifier.runtimeCodeHash),
  );
  if (!hasVaultRegistration) {
    fail(`${kind} execution receipt lacks the matching CapacityVault immutable provenance-registration log.`);
  }

  return {
    proposalId: registration.proposalId,
    actionHash: canonicalActionHash,
    proposalType: expectedProposalName,
    policyVersion: registration.policyVersion,
    approvalsReceived: registration.approvalsReceived,
    approvalsRequired: registration.approvalsRequired,
    requiredMask: registration.requiredMask,
    approvalMask: registration.approvalMask,
    timelockSeconds: registration.timelockSeconds,
    executionTxHash: registration.execution.txHash,
    executionBlockNumber: registration.execution.blockNumber,
    executionBlockHash: registration.execution.blockHash,
  };
}

async function main() {
  const { repoRoot, manifest, manifestPath, manifestSha256 } = loadManifest();

  if (manifest.schemaVersion !== 1) fail("unsupported release manifest schema.");
  if (manifest.chain.chainId !== 2026) fail(`manifest chain ID must be 2026, got ${manifest.chain.chainId}.`);

  const chainIdHex = await rpc<string>("eth_chainId");
  const chainId = BigInt(chainIdHex);
  if (chainId !== BigInt(manifest.chain.chainId)) {
    fail(`RPC chain ID ${chainId.toString()} does not match manifest ${manifest.chain.chainId}.`);
  }

  const genesis = await rpc<RpcBlock>("eth_getBlockByNumber", ["0x0", false]);
  if (!genesis?.hash) fail("RPC did not return canonical genesis block 0.");
  requireEqual(genesis.hash, manifest.chain.genesisHash, "genesis hash");

  const codeEvidence: Record<string, { address: string; runtimeCodeHash: string }> = {};
  for (const entry of manifest.contracts) {
    if (!ethers.isAddress(entry.address)) fail(`${entry.name} has an invalid address in the manifest.`);
    const actualHash = await runtimeCodeHash(entry.address, entry.name);
    requireEqual(actualHash, entry.runtimeCodeHash, `${entry.name} runtime code hash`);
    codeEvidence[entry.name] = { address: entry.address, runtimeCodeHash: actualHash };
  }

  const vaultEntry = manifest.contracts.find((entry) => entry.name === "CapacityVault");
  if (!vaultEntry) fail("CapacityVault is missing from the release manifest.");
  const charterEntry = manifest.contracts.find((entry) => entry.name === "ThreadProofCharter");
  if (!charterEntry) fail("ThreadProofCharter is missing from the release manifest.");

  const spendEvidence = await verifyVerifier(
    "capacitySpend",
    manifest.verifiers.capacitySpend,
    vaultEntry.address,
    "getVerifierProvenance",
  );
  const releaseEvidence = await verifyVerifier(
    "capacityRelease",
    manifest.verifiers.capacityRelease,
    vaultEntry.address,
    "getReleaseVerifierProvenance",
  );

  const governanceFile = loadGovernanceEvidence(repoRoot, manifest);
  const governance = governanceFile.evidence;
  if (governance.format !== GOVERNANCE_FORMAT || governance.result !== "pass" || governance.environment !== "production") {
    fail("verifier-governance evidence is not a passing production v1 artifact.");
  }
  if (governance.releaseVersion !== manifest.release.version) fail("verifier-governance release version mismatch.");
  if (governance.sourceDevelopCommit.toLowerCase() !== manifest.release.sourceDevelopCommit.toLowerCase()) {
    fail("verifier-governance source develop commit mismatch.");
  }
  if (governance.chain.chainId !== manifest.chain.chainId) fail("verifier-governance chain ID mismatch.");
  requireEqual(governance.chain.genesisHash, manifest.chain.genesisHash, "verifier-governance genesis hash");
  requireEqual(governance.contracts.capacityVault, vaultEntry.address, "verifier-governance CapacityVault address");
  requireEqual(governance.contracts.threadProofCharter, charterEntry.address, "verifier-governance ThreadProofCharter address");

  const spendGovernance = await verifyGovernedRegistration(
    "capacitySpend",
    governance.registrations.capacitySpend,
    manifest.verifiers.capacitySpend,
    charterEntry.address,
    vaultEntry.address,
  );
  const releaseGovernance = await verifyGovernedRegistration(
    "capacityRelease",
    governance.registrations.capacityRelease,
    manifest.verifiers.capacityRelease,
    charterEntry.address,
    vaultEntry.address,
  );
  if (sameHex(spendGovernance.proposalId, releaseGovernance.proposalId)) {
    fail("spend and release verifier governance reused the same Charter proposal.");
  }
  if (sameHex(spendGovernance.executionTxHash, releaseGovernance.executionTxHash)) {
    fail("spend and release verifier governance reused the same execution transaction.");
  }

  console.log(
    `THREADPROOF_PRODUCTION_DEPLOYMENT_VERIFIED ${JSON.stringify({
      release: manifest.release.version,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      manifestFile: path.relative(repoRoot, manifestPath),
      manifestSha256,
      chainId: chainId.toString(),
      genesisHash: genesis.hash,
      validatorCountAttested: manifest.chain.validatorCount,
      contracts: codeEvidence,
      verifiers: {
        capacitySpend: spendEvidence,
        capacityRelease: releaseEvidence,
      },
      verifierGovernance: {
        evidenceFile: path.relative(repoRoot, governanceFile.evidencePath),
        evidenceSha256: governanceFile.evidenceSha256,
        capacitySpend: spendGovernance,
        capacityRelease: releaseGovernance,
      },
    })}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
