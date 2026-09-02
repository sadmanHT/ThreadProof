#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const verifier = path.resolve(import.meta.dirname, "verify-release-deployment-evidence.mjs");
const hash32 = (character) => `0x${character.repeat(64)}`;
const address = (suffix) => `0x${"1".repeat(38)}${suffix}`;
const nodeId = (character) => `0x${character.repeat(128)}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

const contracts = [
  ["Registry", "01", "1"],
  ["CredentialRegistry", "02", "2"],
  ["OrderRegistry", "03", "3"],
  ["CapacityVault", "04", "4"],
  ["SubcontractGovernor", "05", "5"],
  ["ThreadProofCharter", "06", "6"],
].map(([name, suffix, hashCharacter]) => ({ name, address: address(suffix), runtimeCodeHash: hash32(hashCharacter) }));

const verifiers = {
  capacitySpend: {
    address: address("07"),
    runtimeCodeHash: hash32("7"),
    circuitArtifactHash: hash32("8"),
    verificationKeyHash: hash32("9"),
    buildAttestationSha256: hash32("a"),
    ceremonyEvidenceSha256: hash32("b"),
  },
  capacityRelease: {
    address: address("08"),
    runtimeCodeHash: hash32("c"),
    circuitArtifactHash: hash32("d"),
    verificationKeyHash: hash32("e"),
    buildAttestationSha256: hash32("f"),
    ceremonyEvidenceSha256: hash32("1"),
  },
};

const serviceIds = [
  "event_indexer",
  "order_relayer",
  "subcontract_relayer",
  "capacity_spend_proof_generator",
  "capacity_spend_submitter",
  "capacity_release_proof_generator",
  "capacity_release_submitter",
];

function evidenceRef(id) {
  return {
    url: `https://evidence.threadproof.invalid/deployment/${id}.json`,
    sha256: sha(`deployment:${id}`),
  };
}

function validator(index) {
  const hex = String(index + 1);
  return {
    validatorId: `validator-${index + 1}`,
    organizationId: hash32(hex),
    validatorAddress: address(`2${index + 1}`),
    nodeId: nodeId(hex),
    administrativeDomain: `admin-domain-${index + 1}`,
    persistentStorage: true,
    privateNetworking: true,
    tlsEnabled: true,
    nodePermissioning: true,
    monitoringEnabled: true,
    evidence: evidenceRef(`validator-${index + 1}`),
  };
}

function service(serviceId, index) {
  const value = {
    serviceId,
    status: "healthy",
    chainId: 2026,
    heartbeatAt: `2026-09-02T10:${String(50 + index).padStart(2, "0")}:00Z`,
    evidence: evidenceRef(serviceId),
  };
  if (serviceId === "event_indexer") {
    value.canonicalCursor = {
      blockNumber: "1200",
      blockHash: hash32("2"),
      observedHeadBlock: "1204",
      observedHeadBlockHash: hash32("3"),
      confirmationDepth: 2,
      reorgQuarantineEnabled: true,
    };
  }
  return value;
}

function baseEvidence() {
  return {
    format: "threadproof-production-deployment/v1",
    result: "pass",
    environment: "production",
    networkType: "persistent-consortium",
    releaseVersion: "v1.0.0",
    sourceDevelopCommit: "a".repeat(40),
    observedAt: "2026-09-02T11:00:00Z",
    chain: {
      networkName: "ThreadProof Production Consortium",
      chainId: 2026,
      genesisHash: hash32("4"),
      validatorCount: 5,
    },
    validators: Array.from({ length: 5 }, (_unused, index) => validator(index)),
    networkControls: {
      privateNetworking: true,
      tlsRequired: true,
      nodePermissioning: true,
      accountPermissioning: true,
      persistentStorage: true,
      monitoring: true,
      backupsConfigured: true,
      evidence: evidenceRef("network-controls"),
    },
    signing: {
      mode: "remote-web3signer",
      kmsOrHsmBacked: true,
      web3SignerTls: true,
      localPrivateKeysDisabled: true,
      keyCustodyDescription: "Validator and transaction signing are remotely mediated by organization-controlled hardware-backed custody.",
      evidence: evidenceRef("signing-controls"),
    },
    contracts: structuredClone(contracts),
    verifiers: structuredClone(verifiers),
    services: serviceIds.map(service),
    signoff: {
      executedBy: "deployment-operator-001",
      reviewerIds: ["infrastructure-reviewer", "security-reviewer"],
      approvedAt: "2026-09-02T11:05:00Z",
      statement: "Reviewers attest that the sanitized deployment record matches the archived operator evidence for the production consortium.",
    },
  };
}

function baseManifest() {
  return {
    schemaVersion: 1,
    release: {
      version: "v1.0.0",
      sourceDevelopCommit: "a".repeat(40),
      preparedAt: "2026-09-02T11:10:00Z",
    },
    chain: {
      networkName: "ThreadProof Production Consortium",
      chainId: 2026,
      genesisHash: hash32("4"),
      validatorCount: 5,
    },
    contracts: structuredClone(contracts),
    verifiers: structuredClone(verifiers),
    signing: {
      mode: "remote-web3signer",
      kmsOrHsmBacked: true,
    },
    evidence: {
      deploymentEvidenceUrl: "https://evidence.threadproof.invalid/releases/v1.0.0/deployment-evidence.json",
      deploymentManifestSha256: "f".repeat(64),
    },
  };
}

function runCase({ mutateEvidence, mutateManifest, tamperAfterHash } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "threadproof-production-deployment-"));
  try {
    const evidence = baseEvidence();
    const manifest = baseManifest();
    mutateEvidence?.(evidence);
    mutateManifest?.(manifest);

    const evidencePath = path.join(temp, "docs/releases/v1.0.0/deployment-evidence.json");
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(evidencePath, serialized, "utf8");
    manifest.evidence.deploymentManifestSha256 = sha(serialized);
    tamperAfterHash?.({ evidencePath, evidence, manifest });

    mkdirSync(path.join(temp, "release"), { recursive: true });
    writeFileSync(path.join(temp, "release/production-release.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return spawnSync(process.execPath, [verifier], { cwd: temp, encoding: "utf8" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function expectPass(options, label) {
  const result = runCase(options);
  if (result.status !== 0) throw new Error(`${label} should pass.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function expectFail(options, label, needle) {
  const result = runCase(options);
  if (result.status === 0) throw new Error(`${label} should fail.`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (needle && !output.includes(needle)) throw new Error(`${label} failed for the wrong reason.\n${output}`);
}

expectPass({}, "complete release-bound production deployment evidence");
expectFail({ tamperAfterHash: ({ evidencePath }) => writeFileSync(evidencePath, "{}\n", "utf8") }, "tampered deployment bytes", "does not match release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.sourceDevelopCommit = "b".repeat(40); } }, "wrong source commit", "does not match the release source commit");
expectFail({ mutateEvidence: (evidence) => { evidence.chain.chainId = 2027; } }, "wrong chain ID", "must equal 2026");
expectFail({ mutateEvidence: (evidence) => { evidence.chain.genesisHash = hash32("5"); } }, "wrong genesis", "does not match the release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.validators.pop(); } }, "insufficient validator records", "validators length must equal chain.validatorCount");
expectFail({ mutateEvidence: (evidence) => { evidence.validators[1].administrativeDomain = evidence.validators[0].administrativeDomain; } }, "duplicate administrative domain", "administrativeDomain is not distinct");
expectFail({ mutateEvidence: (evidence) => { evidence.validators[1].organizationId = evidence.validators[0].organizationId; } }, "duplicate validator organization", "organizationId is not administratively distinct");
expectFail({ mutateEvidence: (evidence) => { evidence.signing.mode = "local-private-key"; } }, "local private-key signing", "must equal remote-web3signer");
expectFail({ mutateEvidence: (evidence) => { evidence.signing.kmsOrHsmBacked = false; } }, "non hardware-backed signer", "kmsOrHsmBacked must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.networkControls.tlsRequired = false; } }, "TLS disabled", "networkControls.tlsRequired must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.validators[0].persistentStorage = false; } }, "ephemeral validator storage", "persistentStorage must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.contracts[3].runtimeCodeHash = hash32("9"); } }, "contract runtime mismatch", "runtimeCodeHash does not match the release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.verifiers.capacitySpend.buildAttestationSha256 = hash32("2"); } }, "verifier provenance mismatch", "buildAttestationSha256 does not match the release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.services.pop(); } }, "missing required service", "required production service");
expectFail({ mutateEvidence: (evidence) => { evidence.services[1].status = "degraded"; } }, "unhealthy production service", "status must equal healthy");
expectFail({ mutateEvidence: (evidence) => { evidence.services[0].heartbeatAt = "2026-09-02T10:00:00Z"; } }, "stale worker heartbeat", "older than 15 minutes");
expectFail({ mutateEvidence: (evidence) => { evidence.services[0].canonicalCursor.reorgQuarantineEnabled = false; } }, "reorg quarantine disabled", "reorgQuarantineEnabled must be true");
expectFail({ mutateEvidence: (evidence) => { evidence.apiKey = "super-sensitive-value"; } }, "secret-bearing field", "forbidden secret-bearing field name");
expectFail({ mutateEvidence: (evidence) => { evidence.signoff.reviewerIds = ["deployment-operator-001", "security-reviewer"]; } }, "self-only review boundary", "should not rely only on the executor");

console.log("Production deployment evidence policy passed release binding, topology, signer, runtime, freshness, provenance, tamper and secret-safety regressions.");
