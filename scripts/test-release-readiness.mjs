#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const checker = path.join(root, "scripts/check-release-readiness.mjs");
const temp = mkdtempSync(path.join(tmpdir(), "threadproof-release-readiness-"));

const h = (character) => `0x${character.repeat(64)}`;
const address = (suffix) => `0x${"1".repeat(38)}${suffix}`;
const sha = (character) => character.repeat(64);

const baseManifest = {
  schemaVersion: 1,
  release: {
    version: "v1.0.0",
    sourceDevelopCommit: "a".repeat(40),
    preparedAt: "2026-09-01T15:30:00Z",
    preparedBy: "release-operator",
  },
  chain: {
    networkName: "ThreadProof Production Consortium",
    chainId: 2026,
    genesisHash: h("1"),
    validatorCount: 5,
  },
  contracts: [
    ["Registry", "01", "2"],
    ["CredentialRegistry", "02", "3"],
    ["OrderRegistry", "03", "4"],
    ["CapacityVault", "04", "5"],
    ["SubcontractGovernor", "05", "6"],
    ["ThreadProofCharter", "06", "7"],
  ].map(([name, suffix, runtime]) => ({ name, address: address(suffix), runtimeCodeHash: h(runtime) })),
  verifiers: {
    capacitySpend: {
      circuitVersion: 1,
      address: address("07"),
      circuitArtifactHash: h("8"),
      verificationKeyHash: h("9"),
      runtimeCodeHash: h("a"),
      buildAttestationSha256: h("1"),
      setup: "production-ceremony",
      ceremonyEvidenceUrl: "https://evidence.threadproof.invalid/capacity-spend",
      ceremonyEvidenceSha256: h("b"),
    },
    capacityRelease: {
      circuitVersion: 1,
      address: address("08"),
      circuitArtifactHash: h("c"),
      verificationKeyHash: h("d"),
      runtimeCodeHash: h("e"),
      buildAttestationSha256: h("2"),
      setup: "production-ceremony",
      ceremonyEvidenceUrl: "https://evidence.threadproof.invalid/capacity-release",
      ceremonyEvidenceSha256: h("f"),
    },
  },
  signing: {
    mode: "remote-web3signer",
    kmsOrHsmBacked: true,
    keyCustodyDescription: "Independent remote signer backed by managed key custody.",
  },
  evidence: {
    cleanStateRunUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/123",
    qbftFaultRunUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/124",
    qbftFaultEvidenceSha256: sha("3"),
    benchmarkBundleUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/123/artifacts/456",
    benchmarkBundleSha256: sha("1"),
    deploymentEvidenceUrl: "https://evidence.threadproof.invalid/deployment",
    deploymentManifestSha256: sha("2"),
    uatAdversarialEvidenceUrl: "https://evidence.threadproof.invalid/uat-adversarial",
    uatAdversarialEvidenceSha256: sha("4"),
    backupRecoveryEvidenceUrl: "https://evidence.threadproof.invalid/backup-recovery",
    backupRecoveryEvidenceSha256: sha("5"),
    platformControlsEvidenceUrl: "https://evidence.threadproof.invalid/platform-controls",
    platformControlsEvidenceSha256: sha("6"),
  },
  externalControls: {
    developBranchProtectionVerified: true,
    mainBranchProtectionVerified: true,
    supabaseLeakedPasswordProtectionVerified: true,
    supabaseProjectRef: "mgxthhwzsvlxpsombydb",
    verifiedAt: "2026-09-01T15:31:00Z",
    verifiedBy: "security-operator",
  },
  approval: {
    changeReference: "release-approval-2026-001",
    productionReleaseApproved: true,
    approvedBy: "consortium-release-manager",
    approvedAt: "2026-09-01T15:32:00Z",
  },
};

function run(manifest) {
  const file = path.join(temp, "manifest.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: { ...process.env, THREADPROOF_RELEASE_MANIFEST: file },
    encoding: "utf8",
  });
}

function expectPass(manifest, label) {
  const result = run(manifest);
  if (result.status !== 0) {
    throw new Error(`${label} should pass.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectFail(manifest, label) {
  const result = run(manifest);
  if (result.status === 0) throw new Error(`${label} should fail.`);
}

try {
  expectPass(structuredClone(baseManifest), "fully attested production release");

  const missingBuildAttestation = structuredClone(baseManifest);
  delete missingBuildAttestation.verifiers.capacitySpend.buildAttestationSha256;
  expectFail(missingBuildAttestation, "missing build-attestation digest");

  const zeroBuildAttestation = structuredClone(baseManifest);
  zeroBuildAttestation.verifiers.capacityRelease.buildAttestationSha256 = `0x${"0".repeat(64)}`;
  expectFail(zeroBuildAttestation, "zero build-attestation digest");

  const leakedPasswordDisabled = structuredClone(baseManifest);
  leakedPasswordDisabled.externalControls.supabaseLeakedPasswordProtectionVerified = false;
  expectFail(leakedPasswordDisabled, "disabled leaked-password protection");

  const unprotectedDevelop = structuredClone(baseManifest);
  unprotectedDevelop.externalControls.developBranchProtectionVerified = false;
  expectFail(unprotectedDevelop, "unprotected develop branch");

  const zeroSourceCommit = structuredClone(baseManifest);
  zeroSourceCommit.release.sourceDevelopCommit = "0".repeat(40);
  expectFail(zeroSourceCommit, "zero source develop commit");

  const developmentSetup = structuredClone(baseManifest);
  developmentSetup.verifiers.capacitySpend.setup = "development";
  expectFail(developmentSetup, "development Groth16 setup");

  const unprefixedCeremonyHash = structuredClone(baseManifest);
  unprefixedCeremonyHash.verifiers.capacitySpend.ceremonyEvidenceSha256 = sha("b");
  expectFail(unprefixedCeremonyHash, "unprefixed ceremony evidence hash");

  const missingFaultRun = structuredClone(baseManifest);
  delete missingFaultRun.evidence.qbftFaultRunUrl;
  expectFail(missingFaultRun, "missing QBFT fault-run URL");

  const zeroFaultEvidence = structuredClone(baseManifest);
  zeroFaultEvidence.evidence.qbftFaultEvidenceSha256 = "0".repeat(64);
  expectFail(zeroFaultEvidence, "zero QBFT fault-evidence digest");

  const insecureFaultUrl = structuredClone(baseManifest);
  insecureFaultUrl.evidence.qbftFaultRunUrl = "http://evidence.threadproof.invalid/qbft-fault";
  expectFail(insecureFaultUrl, "non-HTTPS QBFT fault-run URL");

  const missingUatEvidence = structuredClone(baseManifest);
  delete missingUatEvidence.evidence.uatAdversarialEvidenceUrl;
  expectFail(missingUatEvidence, "missing UAT/adversarial evidence URL");

  const zeroUatEvidence = structuredClone(baseManifest);
  zeroUatEvidence.evidence.uatAdversarialEvidenceSha256 = "0".repeat(64);
  expectFail(zeroUatEvidence, "zero UAT/adversarial evidence digest");

  const insecureUatEvidence = structuredClone(baseManifest);
  insecureUatEvidence.evidence.uatAdversarialEvidenceUrl = "http://evidence.threadproof.invalid/uat-adversarial";
  expectFail(insecureUatEvidence, "non-HTTPS UAT/adversarial evidence URL");

  const missingRecoveryEvidence = structuredClone(baseManifest);
  delete missingRecoveryEvidence.evidence.backupRecoveryEvidenceUrl;
  expectFail(missingRecoveryEvidence, "missing backup/recovery evidence URL");

  const zeroRecoveryEvidence = structuredClone(baseManifest);
  zeroRecoveryEvidence.evidence.backupRecoveryEvidenceSha256 = "0".repeat(64);
  expectFail(zeroRecoveryEvidence, "zero backup/recovery evidence digest");

  const insecureRecoveryEvidence = structuredClone(baseManifest);
  insecureRecoveryEvidence.evidence.backupRecoveryEvidenceUrl = "http://evidence.threadproof.invalid/backup-recovery";
  expectFail(insecureRecoveryEvidence, "non-HTTPS backup/recovery evidence URL");

  const missingPlatformEvidence = structuredClone(baseManifest);
  delete missingPlatformEvidence.evidence.platformControlsEvidenceUrl;
  expectFail(missingPlatformEvidence, "missing platform-controls evidence URL");

  const zeroPlatformEvidence = structuredClone(baseManifest);
  zeroPlatformEvidence.evidence.platformControlsEvidenceSha256 = "0".repeat(64);
  expectFail(zeroPlatformEvidence, "zero platform-controls evidence digest");

  const insecurePlatformEvidence = structuredClone(baseManifest);
  insecurePlatformEvidence.evidence.platformControlsEvidenceUrl = "http://evidence.threadproof.invalid/platform-controls";
  expectFail(insecurePlatformEvidence, "non-HTTPS platform-controls evidence URL");

  const missingSupabaseProject = structuredClone(baseManifest);
  delete missingSupabaseProject.externalControls.supabaseProjectRef;
  expectFail(missingSupabaseProject, "missing Supabase project reference");

  const invalidSupabaseProject = structuredClone(baseManifest);
  invalidSupabaseProject.externalControls.supabaseProjectRef = "INVALID PROJECT REF";
  expectFail(invalidSupabaseProject, "invalid Supabase project reference");

  const placeholder = structuredClone(baseManifest);
  placeholder.release.preparedBy = "REPLACE_ME";
  expectFail(placeholder, "placeholder release metadata");

  const localSigner = structuredClone(baseManifest);
  localSigner.signing.mode = "local-dev";
  expectFail(localSigner, "local production signer");

  const unknownTopLevel = structuredClone(baseManifest);
  unknownTopLevel.metadata = { note: "public but not part of the release contract" };
  expectFail(unknownTopLevel, "unknown top-level field");

  const unknownSectionField = structuredClone(baseManifest);
  unknownSectionField.release.operatorNote = "shadow metadata";
  expectFail(unknownSectionField, "unknown release field");

  const extraContract = structuredClone(baseManifest);
  extraContract.contracts.push({
    name: "UnexpectedRegistry",
    address: address("09"),
    runtimeCodeHash: h("1"),
  });
  expectFail(extraContract, "extra state contract");

  const verifierReusesStateAddress = structuredClone(baseManifest);
  verifierReusesStateAddress.verifiers.capacitySpend.address = verifierReusesStateAddress.contracts[0].address;
  expectFail(verifierReusesStateAddress, "verifier reuses state-contract address");

  const duplicateVerifierAddress = structuredClone(baseManifest);
  duplicateVerifierAddress.verifiers.capacityRelease.address = duplicateVerifierAddress.verifiers.capacitySpend.address;
  expectFail(duplicateVerifierAddress, "duplicate verifier address");

  const secretBearingExtra = structuredClone(baseManifest);
  secretBearingExtra.approval.apiKey = "must-never-be-exported";
  expectFail(secretBearingExtra, "secret-bearing nested field");

  const credentialBearingUrl = structuredClone(baseManifest);
  credentialBearingUrl.evidence.deploymentEvidenceUrl = "https://operator:credential@evidence.threadproof.invalid/deployment";
  expectFail(credentialBearingUrl, "credential-bearing evidence URL");

  const controlsBeforePreparation = structuredClone(baseManifest);
  controlsBeforePreparation.externalControls.verifiedAt = "2026-09-01T15:29:00Z";
  expectFail(controlsBeforePreparation, "external controls verified before manifest preparation");

  const approvalBeforeControls = structuredClone(baseManifest);
  approvalBeforeControls.approval.approvedAt = "2026-09-01T15:30:30Z";
  expectFail(approvalBeforeControls, "release approved before external controls verification");

  console.log("Production release readiness policy checks passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
