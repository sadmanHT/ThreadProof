import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(scriptDir, "..");
const repositoryRoot = resolve(contractsRoot, "../..");
const proofDir = resolve(
  process.env.THREADPROOF_GENERATED_PROOF_DIR ?? join(repositoryRoot, "packages/circuits/artifacts")
);
const generatedDir = join(contractsRoot, "contracts/generated");
const verifierSourcePath = join(generatedDir, "CapacitySpendVerifier.sol");
const wrapperSourcePath = join(generatedDir, "CapacitySpendVerifierWithProvenance.sol");
const manifestPath = join(proofDir, "verifier_provenance.json");

mkdirSync(generatedDir, { recursive: true });

const verifierSource = readFileSync(verifierSourcePath, "utf8");
const contractNames = [...verifierSource.matchAll(/\bcontract\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map(
  (match) => match[1]
);
if (contractNames.length !== 1 || !contractNames[0] || !verifierSource.includes("verifyProof")) {
  throw new Error("Expected exactly one generated verifier contract exposing verifyProof");
}

const circuitArtifactPath = join(proofDir, "CapacitySpend.r1cs");
const verificationKeyPath = join(proofDir, "verification_key.json");
const circuitArtifactHash = keccak256(readFileSync(circuitArtifactPath));
const verificationKeyHash = keccak256(readFileSync(verificationKeyPath));
const generatedVerifierContract = contractNames[0];
const wrapperContract = "CapacitySpendVerifierWithProvenance";

const wrapperSource = `// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {${generatedVerifierContract}} from "./CapacitySpendVerifier.sol";

/// @notice CI-only wrapper that binds the generated verifier to the exact development R1CS and verification key.
/// @dev This is reproducibility evidence, not a production trusted-setup ceremony.
contract ${wrapperContract} {
    bytes32 public constant circuitArtifactHash = ${circuitArtifactHash};
    bytes32 public constant verificationKeyHash = ${verificationKeyHash};

    ${generatedVerifierContract} private immutable _verifier;

    constructor() {
        _verifier = new ${generatedVerifierContract}();
    }

    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[9] calldata publicSignals
    ) external view returns (bool) {
        return _verifier.verifyProof(a, b, c, publicSignals);
    }
}
`;

writeFileSync(wrapperSourcePath, wrapperSource);
const wrapperSourceHash = keccak256(Buffer.from(wrapperSource, "utf8"));
const manifest = {
  schemaVersion: 1,
  setup: "development-only-groth16",
  circuit: "CapacitySpend",
  circuitVersion: 1,
  circuitArtifact: {
    path: "CapacitySpend.r1cs",
    keccak256: circuitArtifactHash,
  },
  verificationKey: {
    path: "verification_key.json",
    keccak256: verificationKeyHash,
  },
  generatedVerifierContract,
  wrapperContract,
  wrapperSourceKeccak256: wrapperSourceHash,
  productionTrustedSetup: false,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`THREADPROOF_VERIFIER_PROVENANCE ${JSON.stringify(manifest)}`);
