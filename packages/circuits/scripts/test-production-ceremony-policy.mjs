import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./verify-production-ceremony.mjs", import.meta.url), "utf8");

const requiredFragments = [
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
];

for (const fragment of requiredFragments) {
  if (!source.includes(fragment)) {
    throw new Error(`Production ceremony verifier is missing required trust-boundary fragment: ${fragment}`);
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
  if (source.includes(prohibited)) {
    throw new Error(`Production ceremony verifier must not create ceremony secret material or use unsupported metadata commands: ${prohibited}`);
  }
}

if (!source.includes('mode !== "production" && mode !== "ci-validation"')) {
  throw new Error("Production ceremony verifier must distinguish production from CI-validation evidence");
}
if (!source.includes("contributionCount < minimumContributionCount")) {
  throw new Error("Production ceremony verifier must fail closed when verified Phase-2 contributions are missing");
}
if (!source.includes('/^[0-9a-f]{40}$/i.test(sourceCommit)') || !source.includes('/^0{40}$/i.test(sourceCommit)')) {
  throw new Error("Production ceremony verifier must bind production evidence to a non-zero exact canonical commit SHA");
}

console.log("Production ceremony verification trust-boundary checks passed.");
