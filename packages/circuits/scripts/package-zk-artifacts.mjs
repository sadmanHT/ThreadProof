import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const packageRoot = process.cwd();
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim().toLowerCase();
const gitTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim().toLowerCase();
const trackedStatus = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: repoRoot, encoding: "utf8" },
).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit) || /^0{40}$/.test(sourceCommit)) {
  throw new Error("ZK reproducibility packaging requires an exact non-zero Git commit SHA");
}
if (trackedStatus) {
  throw new Error(`Tracked working tree must be clean before ZK packaging:\n${trackedStatus}`);
}

const mode = (process.env.THREADPROOF_ZK_PACKAGE_MODE ?? "ci-validation").trim();
if (mode !== "ci-validation" && mode !== "production") {
  throw new Error("THREADPROOF_ZK_PACKAGE_MODE must be ci-validation or production");
}

const artifactsDir = path.resolve(process.env.THREADPROOF_ZK_ARTIFACT_DIR ?? "artifacts");
const ceremonyDir = path.resolve(
  process.env.THREADPROOF_ZK_CEREMONY_DIR ?? path.join(artifactsDir, "ceremony-validation"),
);
const contractsGeneratedDir = path.resolve(
  process.env.THREADPROOF_ZK_GENERATED_CONTRACTS_DIR ??
    path.join(repoRoot, "packages", "contracts", "contracts", "generated"),
);
const vectorPath = path.resolve(
  process.env.THREADPROOF_ZK_VECTOR_PATH ?? path.join("vectors", "CapacitySpend.v1.json"),
);

const defaults = {
  r1cs: path.join(artifactsDir, "CapacitySpend.r1cs"),
  wasm: path.join(artifactsDir, "CapacitySpend_js", "CapacitySpend.wasm"),
  sym: path.join(artifactsDir, "CapacitySpend.sym"),
  zkey: path.join(artifactsDir, "CapacitySpend_dev_final.zkey"),
  powersOfTau: path.join(artifactsDir, "dev-pot14_final.ptau"),
  verificationKey: path.join(artifactsDir, "verification_key.json"),
  proof: path.join(artifactsDir, "proof.json"),
  publicSignals: path.join(artifactsDir, "public.json"),
  solidityVerifier: path.join(artifactsDir, "CapacitySpendVerifier.sol"),
  verifierProvenance: path.join(artifactsDir, "verifier_provenance.json"),
  zkBenchmark: path.join(artifactsDir, "CapacitySpend_benchmark.json"),
  verifierGasBenchmark: path.join(artifactsDir, "CapacitySpend_verifier_gas.json"),
  vectorResults: path.join(artifactsDir, "witness-tests", "vector-results.json"),
  buildAttestation: path.join(
    ceremonyDir,
    "build-verification",
    "CapacitySpend_build_attestation.json",
  ),
  buildAttestationChecksum: path.join(
    ceremonyDir,
    "build-verification",
    "CapacitySpend_build_attestation.json.sha256",
  ),
  ceremonyEvidence: path.join(ceremonyDir, "CapacitySpend_ceremony_evidence.json"),
  ceremonyEvidenceChecksum: path.join(
    ceremonyDir,
    "CapacitySpend_ceremony_evidence.json.sha256",
  ),
  provenanceVerifier: path.join(
    contractsGeneratedDir,
    "CapacitySpendVerifierWithProvenance.sol",
  ),
};

function configured(name, envName) {
  const override = process.env[envName]?.trim();
  return override ? path.resolve(override) : defaults[name];
}

const paths = {
  r1cs: configured("r1cs", "THREADPROOF_ZK_R1CS"),
  wasm: configured("wasm", "THREADPROOF_ZK_WASM"),
  sym: configured("sym", "THREADPROOF_ZK_SYM"),
  zkey: configured("zkey", "THREADPROOF_ZK_ZKEY"),
  powersOfTau: configured("powersOfTau", "THREADPROOF_ZK_PTAU"),
  verificationKey: configured("verificationKey", "THREADPROOF_ZK_VERIFICATION_KEY"),
  proof: configured("proof", "THREADPROOF_ZK_PROOF"),
  publicSignals: configured("publicSignals", "THREADPROOF_ZK_PUBLIC"),
  solidityVerifier: configured("solidityVerifier", "THREADPROOF_ZK_SOLIDITY_VERIFIER"),
  verifierProvenance: configured(
    "verifierProvenance",
    "THREADPROOF_ZK_VERIFIER_PROVENANCE",
  ),
  zkBenchmark: configured("zkBenchmark", "THREADPROOF_ZK_BENCHMARK"),
  verifierGasBenchmark: configured("verifierGasBenchmark", "THREADPROOF_ZK_VERIFIER_GAS_BENCHMARK"),
  vectorResults: configured("vectorResults", "THREADPROOF_ZK_VECTOR_RESULTS"),
  buildAttestation: configured("buildAttestation", "THREADPROOF_ZK_BUILD_ATTESTATION"),
  buildAttestationChecksum: configured(
    "buildAttestationChecksum",
    "THREADPROOF_ZK_BUILD_ATTESTATION_CHECKSUM",
  ),
  ceremonyEvidence: configured("ceremonyEvidence", "THREADPROOF_ZK_CEREMONY_EVIDENCE"),
  ceremonyEvidenceChecksum: configured(
    "ceremonyEvidenceChecksum",
    "THREADPROOF_ZK_CEREMONY_EVIDENCE_CHECKSUM",
  ),
  provenanceVerifier: configured(
    "provenanceVerifier",
    "THREADPROOF_ZK_PROVENANCE_VERIFIER",
  ),
};

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function repoPath(filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return `external/${path.basename(filePath)}`;
  }
  return relative.split(path.sep).join("/");
}

function artifact(filePath) {
  if (!existsSync(filePath)) throw new Error(`Required ZK reproducibility artifact is missing: ${filePath}`);
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
  const bytes = readFileSync(filePath);
  return {
    path: repoPath(filePath),
    filename: path.basename(filePath),
    sizeBytes: stat.size,
    sha256: sha256(bytes),
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}\n${error instanceof Error ? error.message : error}`);
  }
}

const vectorArtifact = artifact(vectorPath);
const vectorResults = readJson(paths.vectorResults, "CapacitySpend vector result manifest");
if (
  vectorResults.format !== "threadproof-capacity-spend-vector-results/v1" ||
  vectorResults.vectorSource?.sha256?.toLowerCase() !== vectorArtifact.sha256.toLowerCase()
) {
  throw new Error("CapacitySpend vector result manifest is not bound to the versioned vector source");
}
const mismatchedVectorResult = vectorResults.results?.find(
  (entry) =>
    (entry.expected === "accept" && entry.result !== "accepted") ||
    (entry.expected === "reject" && entry.result !== "rejected"),
);
if (mismatchedVectorResult) {
  throw new Error(`CapacitySpend vector result mismatch: ${mismatchedVectorResult.id}`);
}

const buildAttestation = readJson(paths.buildAttestation, "Circuit build attestation");
if (
  buildAttestation.format !== "threadproof-circuit-build-attestation/v1" ||
  buildAttestation.sourceCommit?.toLowerCase() !== sourceCommit
) {
  throw new Error("Circuit build attestation is not bound to the exact package source commit");
}
const ceremonyEvidence = readJson(paths.ceremonyEvidence, "Groth16 ceremony evidence");
if (
  ceremonyEvidence.format !== "threadproof-groth16-ceremony-evidence/v1" ||
  ceremonyEvidence.sourceCommit?.toLowerCase() !== sourceCommit ||
  ceremonyEvidence.circuit !== "CapacitySpend"
) {
  throw new Error("Groth16 ceremony evidence is not bound to the exact CapacitySpend source commit");
}
if (mode === "production" && ceremonyEvidence.mode !== "production") {
  throw new Error("Production ZK packaging requires production ceremony evidence");
}
if (mode === "ci-validation" && ceremonyEvidence.mode !== "ci-validation") {
  throw new Error("CI-validation ZK packaging requires ci-validation ceremony evidence");
}

const zkBenchmark = readJson(paths.zkBenchmark, "CapacitySpend benchmark");
if (zkBenchmark.format !== "threadproof-zk-benchmark/v1" || zkBenchmark.circuit !== "CapacitySpend") {
  throw new Error("CapacitySpend benchmark format mismatch");
}
const verifierGasBenchmark = readJson(paths.verifierGasBenchmark, "CapacitySpend verifier gas benchmark");
if (
  verifierGasBenchmark.format !== "threadproof-groth16-verifier-gas/v1" ||
  verifierGasBenchmark.circuit !== "CapacitySpend" ||
  verifierGasBenchmark.sourceCommit?.toLowerCase() !== sourceCommit
) {
  throw new Error("CapacitySpend verifier gas benchmark is not bound to the exact source commit");
}

const packageManifest = {
  schemaVersion: 1,
  format: "threadproof-zk-reproducibility-package/v1",
  circuit: "CapacitySpend",
  circuitVersion: 1,
  mode,
  setup:
    mode === "production"
      ? "production-groth16"
      : "development-only-groth16",
  sourceCommit,
  gitTree,
  trackedCheckoutClean: true,
  artifactPolicy: {
    largeBinariesCommittedToGit: false,
    exactHashesVersionedByManifest: true,
    packageMustBePublishedAsImmutableReleaseOrWorkflowArtifact: true,
    participantEntropyIncluded: false,
    privateKeyMaterialIncluded: false,
  },
  vectors: {
    source: vectorArtifact,
    results: artifact(paths.vectorResults),
    acceptedCases: vectorResults.results.filter((entry) => entry.result === "accepted").length,
    rejectedCases: vectorResults.results.filter((entry) => entry.result === "rejected").length,
  },
  artifacts: {
    r1cs: artifact(paths.r1cs),
    wasm: artifact(paths.wasm),
    sym: artifact(paths.sym),
    finalZkey: artifact(paths.zkey),
    powersOfTau: artifact(paths.powersOfTau),
    verificationKey: artifact(paths.verificationKey),
    canonicalProof: artifact(paths.proof),
    publicSignals: artifact(paths.publicSignals),
    solidityVerifier: artifact(paths.solidityVerifier),
    provenanceVerifier: artifact(paths.provenanceVerifier),
    verifierProvenance: artifact(paths.verifierProvenance),
    buildAttestation: artifact(paths.buildAttestation),
    buildAttestationChecksum: artifact(paths.buildAttestationChecksum),
    ceremonyEvidence: artifact(paths.ceremonyEvidence),
    ceremonyEvidenceChecksum: artifact(paths.ceremonyEvidenceChecksum),
    zkBenchmark: artifact(paths.zkBenchmark),
    verifierGasBenchmark: artifact(paths.verifierGasBenchmark),
  },
  ceremony: {
    mode: ceremonyEvidence.mode,
    ceremonyId: ceremonyEvidence.ceremonyId,
    phase2ContributionCount: ceremonyEvidence.verification?.phase2ContributionCount,
    minimumPhase2ContributionCount:
      ceremonyEvidence.verification?.minimumPhase2ContributionCount,
    finalZkeyVerified: ceremonyEvidence.verification?.finalZkeyVerified === true,
    powersOfTauVerified: ceremonyEvidence.verification?.powersOfTauVerified === true,
  },
  measurements: {
    circuit: zkBenchmark.measurements,
    verifierGas: verifierGasBenchmark.measurements,
  },
  generatedAt: new Date().toISOString(),
  note:
    "Large proving/setup binaries are intentionally excluded from normal Git history. This exact-source manifest hashes every binary, verification key, generated verifier, proof vector result, ceremony/build attestation, and benchmark input that must travel together as the reproducibility package.",
};

const outputDir = path.join(artifactsDir, "reproducibility");
mkdirSync(outputDir, { recursive: true });
const manifestPath = path.join(outputDir, "CapacitySpend_manifest.json");
const manifestBytes = Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
writeFileSync(manifestPath, manifestBytes, { mode: 0o644 });
const manifestSha256 = sha256(manifestBytes);
writeFileSync(
  `${manifestPath}.sha256`,
  `${manifestSha256.slice(2)}  ${path.basename(manifestPath)}\n`,
  { mode: 0o644 },
);

console.log(
  `THREADPROOF_ZK_REPRODUCIBILITY_PACKAGE ${JSON.stringify({
    circuit: packageManifest.circuit,
    mode,
    sourceCommit,
    manifestPath: repoPath(manifestPath),
    manifestSha256,
    artifactCount: Object.keys(packageManifest.artifacts).length,
    acceptedVectorCases: packageManifest.vectors.acceptedCases,
    rejectedVectorCases: packageManifest.vectors.rejectedCases,
  })}`,
);
