import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [new URL("./generate-production-verifier-wrapper.mjs", import.meta.url).pathname, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== expectedStatus) {
    throw new Error(`Unexpected wrapper-generator exit ${result.status}; expected ${expectedStatus}\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

const dir = mkdtempSync(join(tmpdir(), "threadproof-production-wrapper-test-"));
try {
  const r1csPath = join(dir, "CapacitySpend.r1cs");
  const verificationKeyPath = join(dir, "CapacitySpend_verification_key.json");
  const verifierPath = join(dir, "CapacitySpendVerifier.sol");
  const evidencePath = join(dir, "CapacitySpend_ceremony_evidence.json");
  const outDir = join(dir, "generated");

  const r1cs = Buffer.from("threadproof-test-r1cs");
  const verificationKey = Buffer.from('{"protocol":"groth16"}\n');
  const verifier = Buffer.from(
    "// SPDX-License-Identifier: GPL-3.0\npragma solidity ^0.8.28;\ncontract Groth16Verifier { function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[9] calldata) public pure returns (bool) { return true; } }\n",
  );
  writeFileSync(r1csPath, r1cs);
  writeFileSync(verificationKeyPath, verificationKey);
  writeFileSync(verifierPath, verifier);

  const evidence = {
    schemaVersion: 1,
    format: "threadproof-groth16-ceremony-evidence/v1",
    mode: "production",
    circuit: "CapacitySpend",
    circuitVersion: 1,
    ceremonyId: "test-ceremony",
    sourceCommit: "1111111111111111111111111111111111111111",
    verification: {
      phase2ContributionCount: 2,
    },
    artifacts: {
      r1cs: { sha256: sha256(r1cs) },
      verificationKey: { sha256: sha256(verificationKey) },
      solidityVerifier: { sha256: sha256(verifier) },
    },
    handling: {
      participantEntropyAcceptedByThisTool: false,
      participantPrivateMaterialPersistedByThisTool: false,
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const commonArgs = [
    "--circuit", "CapacitySpend",
    "--r1cs", r1csPath,
    "--verification-key", verificationKeyPath,
    "--verifier-sol", verifierPath,
    "--ceremony-evidence", evidencePath,
    "--out-dir", outDir,
  ];

  const output = run(commonArgs);
  if (!output.includes("THREADPROOF_PRODUCTION_VERIFIER_PROVENANCE")) {
    throw new Error("Production wrapper generator did not emit provenance summary");
  }
  const wrapper = readFileSync(join(outDir, "CapacitySpendVerifierWithProvenance.sol"), "utf8");
  if (!wrapper.includes("ceremonyEvidenceSha256")) {
    throw new Error("Production verifier is not bound to ceremony evidence");
  }
  if (!wrapper.includes("contract CapacitySpendVerifierWithProvenance is CapacitySpendGroth16Verifier")) {
    throw new Error("Production verifier must inherit the generated Groth16 verifier directly");
  }
  if (wrapper.includes("new CapacitySpendGroth16Verifier") || wrapper.includes("_verifier")) {
    throw new Error("Production verifier must not deploy or forward to a hidden child verifier");
  }

  const normalizedVerifier = readFileSync(join(outDir, "CapacitySpendVerifier.sol"), "utf8");
  if (!normalizedVerifier.includes("contract CapacitySpendGroth16Verifier")) {
    throw new Error("Generated verifier identity was not normalized deterministically");
  }

  const provenance = JSON.parse(
    readFileSync(join(outDir, "CapacitySpend_production_verifier_provenance.json"), "utf8"),
  );
  if (provenance.setup !== "production-ceremony" || provenance.productionTrustedSetup !== true) {
    throw new Error("Production provenance manifest does not identify production ceremony setup");
  }
  if (provenance.verifierComposition !== "direct-inheritance") {
    throw new Error("Production provenance must record the self-contained verifier composition");
  }
  if (provenance.phase2ContributionCount !== 2 || provenance.sourceCommit !== evidence.sourceCommit) {
    throw new Error("Production provenance manifest lost ceremony contribution/source binding");
  }

  evidence.mode = "ci-validation";
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const rejectedMode = run(commonArgs, 1);
  if (!rejectedMode.includes("mode=production")) {
    throw new Error("CI-validation evidence was not rejected for a production wrapper");
  }

  evidence.mode = "production";
  evidence.artifacts.verificationKey.sha256 = `0x${"00".repeat(32)}`;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const rejectedHash = run(commonArgs, 1);
  if (!rejectedHash.includes("verification key SHA-256")) {
    throw new Error("Mismatched verification-key evidence was not rejected");
  }

  console.log("Production verifier wrapper provenance checks passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
