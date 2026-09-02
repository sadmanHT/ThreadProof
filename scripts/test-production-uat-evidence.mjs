#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const verifier = path.resolve(import.meta.dirname, "verify-release-uat-evidence.mjs");
const hash32 = (character) => `0x${character.repeat(64)}`;
const address = (suffix) => `0x${"1".repeat(38)}${suffix}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

const contractAddresses = {
  Registry: address("01"),
  CredentialRegistry: address("02"),
  OrderRegistry: address("03"),
  CapacityVault: address("04"),
  SubcontractGovernor: address("05"),
  ThreadProofCharter: address("06"),
};
const contractForCase = {
  onboarding: "Registry",
  credential_issue: "CredentialRegistry",
  credential_revocation: "CredentialRegistry",
  capacity_certification: "CapacityVault",
  order_authorization: "OrderRegistry",
  pofc_spend: "CapacityVault",
  subcontract_authorization: "SubcontractGovernor",
  order_amendment: "OrderRegistry",
  order_cancellation: "OrderRegistry",
  capacity_release: "CapacityVault",
  due_process_disclosure: "ThreadProofCharter",
};
const functionalParticipants = {
  onboarding: ["factory-primary", "auditor"],
  credential_issue: ["factory-primary", "auditor"],
  credential_revocation: ["factory-primary", "auditor"],
  capacity_certification: ["factory-primary", "auditor"],
  order_authorization: ["buyer", "factory-primary"],
  pofc_spend: ["buyer", "factory-primary"],
  subcontract_authorization: ["factory-primary", "factory-sub"],
  order_amendment: ["buyer", "factory-primary"],
  order_cancellation: ["buyer", "factory-primary"],
  capacity_release: ["buyer", "factory-primary"],
  due_process_disclosure: ["auditor", "regulator"],
  credential_package_export: ["factory-primary", "auditor"],
  credential_package_verification: ["buyer"],
};
const functionalIds = Object.keys(functionalParticipants);
const adversarialIds = [
  "stale_capacity",
  "duplicate_nullifier",
  "invalid_proof",
  "invalid_allocation",
  "release_replay",
  "revoked_credential",
  "rpc_outage",
  "signer_outage",
  "validator_loss",
];

function transcript(id) {
  return {
    transcriptUrl: `https://evidence.threadproof.invalid/uat/${id}.json`,
    transcriptSha256: sha(`transcript:${id}`),
  };
}

function receipt(id, index) {
  return {
    chainId: 2026,
    transactionHash: hash32(((index % 8) + 1).toString()),
    blockNumber: String(100 + index),
    blockHash: hash32(((index % 7) + 2).toString()),
    contractAddress: contractAddresses[contractForCase[id]],
    eventName: `ThreadProof${id.replace(/(^|_)([a-z])/g, (_match, _prefix, letter) => letter.toUpperCase())}`,
  };
}

function packageEvidence(id) {
  return {
    url: `https://evidence.threadproof.invalid/packages/${id}.json`,
    sha256: sha(`package:${id}`),
    format: id === "due_process_disclosure"
      ? "threadproof-protected-identity-disclosure/v1"
      : "threadproof-credential-package/v1",
  };
}

function functionalCase(id, index) {
  const evidence = transcript(id);
  if (contractForCase[id]) evidence.chainReceipt = receipt(id, index);
  if (["due_process_disclosure", "credential_package_export", "credential_package_verification"].includes(id)) {
    evidence.package = packageEvidence(id);
  }
  return {
    id,
    result: "pass",
    participantIds: functionalParticipants[id],
    expected: `Expected successful production UAT behavior for ${id}`,
    observed: `Observed successful production UAT behavior for ${id}`,
    startedAt: `2026-09-02T10:${String(index).padStart(2, "0")}:00Z`,
    completedAt: `2026-09-02T10:${String(index).padStart(2, "0")}:30Z`,
    evidence,
  };
}

function rejection(id) {
  return {
    errorCode: `REJECT_${id.toUpperCase()}`,
    requestSha256: sha(`request:${id}`),
    canonicalStateUnchanged: true,
    beforeStateHash: hash32("a"),
    afterStateHash: hash32("a"),
  };
}

function adversarialCase(id, index) {
  const evidence = transcript(id);
  let participantIds = ["factory-primary", "auditor"];
  if (["rpc_outage", "signer_outage"].includes(id)) {
    participantIds = ["buyer", "factory-primary"];
    evidence.outage = {
      mode: id.replace("_outage", ""),
      operationRejected: true,
      safetyPreserved: true,
      observedDurationMs: 95_000,
      beforeStateHash: hash32("b"),
      afterStateHash: hash32("b"),
    };
  } else if (id === "validator_loss") {
    participantIds = ["auditor", "regulator"];
    evidence.outage = {
      mode: "validator",
      safetyPreserved: true,
      oneUnavailable: { startBlock: "100", endBlock: "102" },
      quorumLost: {
        startBlock: "103",
        endBlock: "103",
        rpcResponsive: true,
        operationRejected: true,
        observedDurationMs: 95_000,
        beforeStateHash: hash32("c"),
        afterStateHash: hash32("c"),
      },
      recovered: { startBlock: "103", endBlock: "105" },
    };
  } else {
    evidence.rejection = rejection(id);
  }
  return {
    id,
    result: "pass",
    participantIds,
    expected: `Expected defensive production behavior for ${id}`,
    observed: `Observed defensive production behavior for ${id}`,
    startedAt: `2026-09-02T10:${String(index + 20).padStart(2, "0")}:00Z`,
    completedAt: `2026-09-02T10:${String(index + 20).padStart(2, "0")}:30Z`,
    evidence,
  };
}

function baseEvidence() {
  return {
    format: "threadproof-production-uat/v1",
    result: "pass",
    releaseVersion: "v1.0.0",
    sourceDevelopCommit: "a".repeat(40),
    chainId: 2026,
    genesisHash: hash32("1"),
    validatorCount: 5,
    deploymentManifestSha256: sha("deployment-manifest"),
    environment: "production",
    networkType: "persistent-consortium",
    signing: { mode: "remote-web3signer", kmsOrHsmBacked: true },
    startedAt: "2026-09-02T10:00:00Z",
    completedAt: "2026-09-02T11:00:00Z",
    participants: [
      { participantId: "buyer", role: "buyer", organizationId: hash32("2"), walletAddress: address("11") },
      { participantId: "factory-primary", role: "factory", organizationId: hash32("3"), walletAddress: address("12") },
      { participantId: "factory-sub", role: "factory", organizationId: hash32("4"), walletAddress: address("13") },
      { participantId: "auditor", role: "auditor", organizationId: hash32("5"), walletAddress: address("14") },
      { participantId: "regulator", role: "regulator", organizationId: hash32("6"), walletAddress: address("15") },
      { participantId: "worker-labor", role: "worker_labor", organizationId: hash32("7"), walletAddress: address("16") },
    ],
    functionalCases: functionalIds.map(functionalCase),
    adversarialCases: adversarialIds.map(adversarialCase),
    signoff: {
      executedBy: "uat-operator-2026-001",
      reviewerParticipantIds: ["auditor", "regulator"],
      approvedAt: "2026-09-02T11:05:00Z",
      statement: "Auditor and regulator reviewers attest that the recorded outcomes match the archived sanitized UAT transcripts.",
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
      chainId: 2026,
      genesisHash: hash32("1"),
      validatorCount: 5,
    },
    contracts: Object.entries(contractAddresses).map(([name, contractAddress]) => ({ name, address: contractAddress })),
    signing: {
      mode: "remote-web3signer",
      kmsOrHsmBacked: true,
    },
    evidence: {
      deploymentManifestSha256: sha("deployment-manifest"),
      uatAdversarialEvidenceUrl: "https://evidence.threadproof.invalid/releases/v1.0.0/uat-adversarial-evidence.json",
      uatAdversarialEvidenceSha256: "f".repeat(64),
    },
  };
}

function runCase({ mutateEvidence, mutateManifest, tamperAfterHash } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "threadproof-production-uat-"));
  try {
    const evidence = baseEvidence();
    const manifest = baseManifest();
    mutateEvidence?.(evidence);
    mutateManifest?.(manifest);

    const evidencePath = path.join(temp, "docs/releases/v1.0.0/uat-adversarial-evidence.json");
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(evidencePath, serialized, "utf8");
    manifest.evidence.uatAdversarialEvidenceSha256 = sha(serialized);
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

expectPass({}, "complete release-bound UAT evidence");
expectFail({ tamperAfterHash: ({ evidencePath }) => writeFileSync(evidencePath, "{}\n", "utf8") }, "tampered evidence bytes", "does not match release manifest");
expectFail({ mutateEvidence: (evidence) => { evidence.sourceDevelopCommit = "b".repeat(40); } }, "wrong source commit", "does not match the release source commit");
expectFail({ mutateEvidence: (evidence) => { evidence.functionalCases = evidence.functionalCases.filter((entry) => entry.id !== "capacity_release"); } }, "missing required functional case", "required functional case capacity_release is missing");
expectFail({ mutateEvidence: (evidence) => { evidence.functionalCases.find((entry) => entry.id === "subcontract_authorization").participantIds = ["factory-primary"]; } }, "single-factory subcontract evidence", "distinct parent and subcontract factory");
expectFail({ mutateEvidence: (evidence) => { evidence.functionalCases.find((entry) => entry.id === "pofc_spend").evidence.chainReceipt.contractAddress = contractAddresses.OrderRegistry; } }, "receipt bound to wrong deployed contract", "must equal release CapacityVault");
expectFail({ mutateEvidence: (evidence) => { const entry = evidence.adversarialCases.find((item) => item.id === "duplicate_nullifier"); entry.evidence.rejection.afterStateHash = hash32("d"); } }, "rejection that mutates canonical state", "changed canonical state");
expectFail({ mutateEvidence: (evidence) => { const entry = evidence.adversarialCases.find((item) => item.id === "validator_loss"); entry.evidence.outage.oneUnavailable.endBlock = "101"; } }, "validator tolerance without block progress", "at least two finalized blocks");
expectFail({ mutateEvidence: (evidence) => { const entry = evidence.adversarialCases.find((item) => item.id === "validator_loss"); entry.evidence.outage.quorumLost.endBlock = "104"; } }, "quorum-loss evidence that still progresses", "no finalized block progress");
expectFail({ mutateEvidence: (evidence) => { evidence.signing.mode = "local-dev"; } }, "local signer UAT", "must equal remote-web3signer");
expectFail({ mutateEvidence: (evidence) => { evidence.signoff.reviewerParticipantIds = ["auditor", "worker-labor"]; } }, "missing regulator signoff", "both auditor and regulator reviewers");
expectFail({ mutateEvidence: (evidence) => { evidence.completedAt = "2026-09-02T11:20:00Z"; } }, "UAT after release preparation", "must not be after release.preparedAt");
expectFail({ mutateEvidence: (evidence) => { evidence.apiKey = "not-a-real-key"; } }, "secret-bearing evidence field", "forbidden secret-bearing field name");
expectFail({ mutateEvidence: (evidence) => { evidence.participants.find((item) => item.participantId === "factory-sub").organizationId = evidence.participants.find((item) => item.participantId === "factory-primary").organizationId; } }, "reused consortium identity", "organizationId is not distinct");

console.log("Production UAT evidence policy checks passed.");
