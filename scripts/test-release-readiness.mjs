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
    benchmarkBundleUrl: "https://github.com/sadmanHT/ThreadProof/actions/runs/123/artifacts/456",
    benchmarkBundleSha256: sha("1"),
    deploymentEvidenceUrl: "https://evidence.threadproof.invalid/deployment",
    deploymentManifestSha256: sha("2"),
  },
  externalControls: {
    developBranchProtectionVerified: true,
    mainBranchProtectionVerified: true,
    supabaseLeakedPasswordProtectionVerified: true,
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
  if (result.status === 0) {
    throw new Error(`${label} should fail.`);
  }
}

try {
  expectPass(structuredClone(baseManifest), "fully attested production release");

  const leakedPasswordDisabled = structuredClone(baseManifest);
  leakedPasswordDisabled.externalControls.supabaseLeakedPasswordProtectionVerified = false;
  expectFail(leakedPasswordDisabled, "disabled leaked-password protection");

  const unprotectedDevelop = structuredClone(baseManifest);
  unprotectedDevelop.externalControls.developBranchProtectionVerified = false;
  expectFail(unprotectedDevelop, "unprotected develop branch");

  const developmentSetup = structuredClone(baseManifest);
  developmentSetup.verifiers.capacitySpend.setup = "development";
  expectFail(developmentSetup, "development Groth16 setup");

  const unprefixedCeremonyHash = structuredClone(baseManifest);
  unprefixedCeremonyHash.verifiers.capacitySpend.ceremonyEvidenceSha256 = sha("b");
  expectFail(unprefixedCeremonyHash, "unprefixed ceremony evidence hash");

  const placeholder = structuredClone(baseManifest);
  placeholder.release.preparedBy = "REPLACE_ME";
  expectFail(placeholder, "placeholder release metadata");

  const localSigner = structuredClone(baseManifest);
  localSigner.signing.mode = "local-dev";
  expectFail(localSigner, "local production signer");

  console.log("Production release readiness policy checks passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
