import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./verify-production-ceremony.mjs", import.meta.url), "utf8");

const requiredFragments = [
  '"powersoftau", "verify"',
  '"zkey", "verify"',
  '"zkey", "export", "json"',
  '"zkey", "export", "verificationkey"',
  '"zkey", "export", "solidityverifier"',
  "phase2ContributionCount",
  "minimumPhase2ContributionCount",
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

for (const prohibited of ["zkey contribute", "powersoftau contribute", "-e=", "--entropy", "privateKey"]) {
  if (source.includes(prohibited)) {
    throw new Error(`Production ceremony verifier must not create ceremony secret material: ${prohibited}`);
  }
}

if (!source.includes('mode !== "production" && mode !== "ci-validation"')) {
  throw new Error("Production ceremony verifier must distinguish production from CI-validation evidence");
}
if (!source.includes("contributions.length < minimumContributionCount")) {
  throw new Error("Production ceremony verifier must fail closed when Phase-2 contributions are missing");
}
if (!source.includes('/^[0-9a-f]{40}$/i.test(sourceCommit)')) {
  throw new Error("Production ceremony verifier must bind production evidence to an exact canonical commit SHA");
}

console.log("Production ceremony verification trust-boundary checks passed.");
