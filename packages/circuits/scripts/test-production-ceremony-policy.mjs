import { readFileSync } from "node:fs";

const ceremonySource = readFileSync(new URL("./verify-production-ceremony.mjs", import.meta.url), "utf8");
const buildSource = readFileSync(new URL("./verify-circuit-build.mjs", import.meta.url), "utf8");

const requiredCeremonyFragments = [
  '"powersoftau", "verify"',
  '"zkey", "verify"',
  '"zkey", "export", "verificationkey"',
  '"zkey", "export", "solidityverifier"',
  "verifiedContributionCount",
  "contribution\\s+#(\\d+)",
  "phase2ContributionCount",
  "minimumPhase2ContributionCount",
  "installedSnarkjsVersion",
  'require.resolve("snarkjs")',
  'join(cursor, "package.json")',
  'packageMetadata.name === "snarkjs"',
  "participantEntropyAcceptedByThisTool: false",
  "participantPrivateMaterialPersistedByThisTool: false",
  "finalZkeyCopiedByThisTool: false",
  "source-commit",
  "ceremony-id",
  "sha256",
  'join(scriptDir, "verify-circuit-build.mjs")',
  "circuitBuildRecompiled: true",
  "sourceCommitMatchedCleanGitHead: true",
  "buildAttestation",
  "dependencyFileCount",
];

for (const fragment of requiredCeremonyFragments) {
  if (!ceremonySource.includes(fragment)) {
    throw new Error(`Production ceremony verifier is missing required trust-boundary fragment: ${fragment}`);
  }
}

const requiredBuildFragments = [
  'REQUIRED_CIRCOM_VERSION = "2.2.0"',
  'PINNED_CIRCOM_REVISION = "9fd40a34f42912ee52230f8b6a114d78f6df1a48"',
  '["status", "--porcelain", "--untracked-files=no"]',
  '["rev-parse", "HEAD^{tree}"]',
  "collectCircuitClosure",
  '"--r1cs"',
  '"--wasm"',
  '"--sym"',
  "rebuiltR1cs.sha256.toLowerCase() !== suppliedR1cs.sha256.toLowerCase()",
  "recompiledR1csMatched: true",
  "sourceCommitMatchedHead: true",
  "dependencyClosureHashed: true",
  "compilerBinaryHashed: true",
  "lockfileHashed: true",
  'resolve(repoRoot, "pnpm-lock.yaml")',
  'resolve(packageRoot, "package.json")',
  "threadproof-circuit-build-attestation/v1",
];
for (const fragment of requiredBuildFragments) {
  if (!buildSource.includes(fragment)) {
    throw new Error(`Circuit build verifier is missing required provenance fragment: ${fragment}`);
  }
}

for (const prohibited of [
  "zkey contribute",
  "powersoftau contribute",
  '"zkey", "export", "json"',
  'runSnarkjs(["--version"])',
  'require.resolve("snarkjs/package.json")',
  "-e=",
  "--entropy",
  "privateKey",
]) {
  if (ceremonySource.includes(prohibited) || buildSource.includes(prohibited)) {
    throw new Error(`Production ZK verification tooling must not create or accept secret ceremony material: ${prohibited}`);
  }
}

if (!ceremonySource.includes('mode !== "production" && mode !== "ci-validation"')) {
  throw new Error("Production ceremony verifier must distinguish production from CI-validation evidence");
}
if (!ceremonySource.includes("contributionCount < minimumContributionCount")) {
  throw new Error("Production ceremony verifier must fail closed when verified Phase-2 contributions are missing");
}
if (!ceremonySource.includes("Production verification requires explicit --source-commit")) {
  throw new Error("Production ceremony verification must require an explicit canonical source commit");
}
if (!buildSource.includes("sourceCommit !== gitHead")) {
  throw new Error("Circuit build verification must require the named source commit to equal the actual Git HEAD");
}

console.log("Production ceremony and circuit-build trust-boundary checks passed.");
