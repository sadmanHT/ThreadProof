#!/usr/bin/env node

import { createHash } from "node:crypto";
import { validateProductionVerifierGovernanceEvidence } from "./production-verifier-governance-evidence.mjs";
import { verifyReleaseBoundVerifierGovernanceBytes } from "./verify-release-verifier-governance-evidence.mjs";

const h = (character) => `0x${character.repeat(64)}`;
const address = (suffix) => `0x${"1".repeat(38)}${suffix}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const manifest = {
  release: {
    version: "v1.0.0",
    sourceDevelopCommit: "a".repeat(40),
    preparedAt: "2026-09-03T01:30:00Z",
  },
  chain: {
    chainId: 2026,
    genesisHash: h("1"),
  },
  contracts: [
    { name: "CapacityVault", address: address("04") },
    { name: "ThreadProofCharter", address: address("06") },
  ],
  verifiers: {
    capacitySpend: {
      circuitVersion: 3,
      address: address("07"),
      circuitArtifactHash: h("8"),
      verificationKeyHash: h("9"),
    },
    capacityRelease: {
      circuitVersion: 4,
      address: address("08"),
      circuitArtifactHash: h("a"),
      verificationKeyHash: h("b"),
    },
  },
  evidence: {
    verifierGovernanceEvidenceUrl: "https://evidence.threadproof.invalid/verifier-governance/v1",
    verifierGovernanceEvidenceSha256: "f".repeat(64),
  },
};

const registration = ({ release = false } = {}) => ({
  proposalId: release ? h("d") : h("c"),
  proposalType: release ? "ReleaseVerifierRegistration" : "VerifierRegistration",
  proposalTypeCode: release ? 14 : 8,
  actionHash: release ? h("e") : h("f"),
  circuitVersion: release ? 4 : 3,
  verifierAddress: release ? address("08") : address("07"),
  circuitArtifactHash: release ? h("a") : h("8"),
  verificationKeyHash: release ? h("b") : h("9"),
  proposalState: "executed",
  policyVersion: 2,
  approvalsReceived: 4,
  approvalsRequired: 4,
  eligibleMask: 31,
  requiredMask: 12,
  approvalMask: release ? 29 : 15,
  timelockSeconds: 86400,
  approvedAt: release ? "2026-09-02T00:05:00Z" : "2026-09-02T00:00:00Z",
  executeAfter: release ? "2026-09-03T00:05:00Z" : "2026-09-03T00:00:00Z",
  execution: {
    txHash: release ? h("2") : h("3"),
    blockNumber: release ? 1002 : 1001,
    blockHash: release ? h("4") : h("5"),
    executedAt: release ? "2026-09-03T00:05:10Z" : "2026-09-03T00:00:10Z",
    executorAddress: release ? address("10") : address("09"),
  },
});

const baseEvidence = {
  format: "threadproof-production-verifier-governance/v1",
  result: "pass",
  environment: "production",
  releaseVersion: "v1.0.0",
  sourceDevelopCommit: "a".repeat(40),
  observedAt: "2026-09-03T00:15:00Z",
  chain: {
    chainId: 2026,
    genesisHash: h("1"),
  },
  contracts: {
    capacityVault: address("04"),
    threadProofCharter: address("06"),
  },
  registrations: {
    capacitySpend: registration(),
    capacityRelease: registration({ release: true }),
  },
};

const expected = {
  releaseVersion: manifest.release.version,
  sourceDevelopCommit: manifest.release.sourceDevelopCommit,
  preparedAt: manifest.release.preparedAt,
  chainId: manifest.chain.chainId,
  genesisHash: manifest.chain.genesisHash,
  contracts: manifest.contracts,
  verifiers: manifest.verifiers,
};

function expectPass(evidence, label) {
  try {
    validateProductionVerifierGovernanceEvidence(evidence, expected);
  } catch (error) {
    throw new Error(`${label} should pass: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function expectFail(evidence, label) {
  let failed = false;
  try {
    validateProductionVerifierGovernanceEvidence(evidence, expected);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`${label} should fail.`);
}

expectPass(structuredClone(baseEvidence), "complete governed verifier registrations");

const wrongSource = structuredClone(baseEvidence);
wrongSource.sourceDevelopCommit = "b".repeat(40);
expectFail(wrongSource, "wrong source commit");

const wrongChain = structuredClone(baseEvidence);
wrongChain.chain.chainId = 1;
expectFail(wrongChain, "wrong chain id");

const wrongGenesis = structuredClone(baseEvidence);
wrongGenesis.chain.genesisHash = h("6");
expectFail(wrongGenesis, "wrong genesis");

const wrongVault = structuredClone(baseEvidence);
wrongVault.contracts.capacityVault = address("11");
expectFail(wrongVault, "wrong capacity vault");

const wrongCharter = structuredClone(baseEvidence);
wrongCharter.contracts.threadProofCharter = address("12");
expectFail(wrongCharter, "wrong charter");

const wrongVerifier = structuredClone(baseEvidence);
wrongVerifier.registrations.capacitySpend.verifierAddress = address("13");
expectFail(wrongVerifier, "wrong verifier address");

const wrongCircuit = structuredClone(baseEvidence);
wrongCircuit.registrations.capacityRelease.circuitVersion = 7;
expectFail(wrongCircuit, "wrong circuit version");

const wrongProposalType = structuredClone(baseEvidence);
wrongProposalType.registrations.capacitySpend.proposalType = "ReleaseVerifierRegistration";
expectFail(wrongProposalType, "wrong proposal type");

const insufficientThreshold = structuredClone(baseEvidence);
insufficientThreshold.registrations.capacitySpend.approvalsRequired = 3;
expectFail(insufficientThreshold, "insufficient governance threshold");

const missingRequiredAuditor = structuredClone(baseEvidence);
missingRequiredAuditor.registrations.capacitySpend.requiredMask = 8;
expectFail(missingRequiredAuditor, "auditor not required");

const missingRegulatorApproval = structuredClone(baseEvidence);
missingRegulatorApproval.registrations.capacitySpend.approvalMask = 7;
expectFail(missingRegulatorApproval, "regulator approval absent");

const shortTimelock = structuredClone(baseEvidence);
shortTimelock.registrations.capacitySpend.timelockSeconds = 3600;
shortTimelock.registrations.capacitySpend.executeAfter = "2026-09-02T01:00:00Z";
expectFail(shortTimelock, "short verifier governance timelock");

const unexecuted = structuredClone(baseEvidence);
unexecuted.registrations.capacitySpend.proposalState = "executable";
expectFail(unexecuted, "unexecuted proposal");

const executionBeforeTimelock = structuredClone(baseEvidence);
executionBeforeTimelock.registrations.capacitySpend.execution.executedAt = "2026-09-02T23:59:59Z";
expectFail(executionBeforeTimelock, "execution before timelock");

const duplicateProposal = structuredClone(baseEvidence);
duplicateProposal.registrations.capacityRelease.proposalId = duplicateProposal.registrations.capacitySpend.proposalId;
expectFail(duplicateProposal, "duplicate charter proposal");

const duplicateTx = structuredClone(baseEvidence);
duplicateTx.registrations.capacityRelease.execution.txHash = duplicateTx.registrations.capacitySpend.execution.txHash;
expectFail(duplicateTx, "duplicate execution transaction");

const staleObservation = structuredClone(baseEvidence);
staleObservation.observedAt = "2026-08-20T00:00:00Z";
expectFail(staleObservation, "stale governance observation");

const unknownField = structuredClone(baseEvidence);
unknownField.registrations.capacitySpend.operatorNote = "shadow metadata";
expectFail(unknownField, "unknown evidence field");

const secretField = structuredClone(baseEvidence);
secretField.registrations.capacitySpend.apiKey = "must-never-be-exported";
expectFail(secretField, "secret-bearing evidence field");

const credentialUrl = structuredClone(baseEvidence);
credentialUrl.registrations.capacitySpend.execution.note = "https://user:secret@evidence.threadproof.invalid";
expectFail(credentialUrl, "credential-bearing URL and unknown field");

const bytes = Buffer.from(`${JSON.stringify(baseEvidence, null, 2)}\n`, "utf8");
const boundManifest = structuredClone(manifest);
boundManifest.evidence.verifierGovernanceEvidenceSha256 = sha256(bytes);
const summary = verifyReleaseBoundVerifierGovernanceBytes(boundManifest, bytes, "synthetic-test");
if (summary.evidenceSha256 !== boundManifest.evidence.verifierGovernanceEvidenceSha256) {
  throw new Error("exact-byte verifier-governance binding did not return the manifest digest.");
}

const tamperedBytes = Buffer.from(bytes);
tamperedBytes[tamperedBytes.length - 2] ^= 1;
let tamperFailed = false;
try {
  verifyReleaseBoundVerifierGovernanceBytes(boundManifest, tamperedBytes, "synthetic-tamper");
} catch {
  tamperFailed = true;
}
if (!tamperFailed) throw new Error("tampered verifier-governance evidence bytes should fail.");

console.log("Production verifier-governance evidence policy checks passed.");
