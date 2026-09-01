import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

const ALLOWED_ARGUMENTS = new Set([
  "mode",
  "circuit",
  "r1cs",
  "ptau",
  "zkey",
  "out-dir",
  "ceremony-id",
  "source-commit",
  "min-contributions",
]);

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!ALLOWED_ARGUMENTS.has(key)) {
      throw new Error(
        `Unsupported argument --${key}. Ceremony verification never accepts entropy, seed, private-key, or beacon material.`,
      );
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed.set(key, value);
    i += 1;
  }
  return parsed;
}

function required(args, key) {
  const value = args.get(key)?.trim();
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function runSnarkjs(args) {
  const result = spawnSync("snarkjs", args, {
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`snarkjs ${args.join(" ")} failed:\n${output}`);
  }
  return output;
}

function installedSnarkjsVersion() {
  const entryPath = require.resolve("snarkjs");
  let cursor = dirname(entryPath);
  while (true) {
    const candidate = join(cursor, "package.json");
    try {
      const packageMetadata = JSON.parse(readFileSync(candidate, "utf8"));
      if (packageMetadata.name === "snarkjs") {
        if (typeof packageMetadata.version !== "string" || !packageMetadata.version.trim()) {
          throw new Error("Installed snarkjs package metadata does not contain a version");
        }
        return packageMetadata.version.trim();
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("Could not locate installed snarkjs package metadata from its exported entrypoint");
}

function sha256File(path) {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function artifact(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return {
    filename: basename(path),
    sizeBytes: stat.size,
    sha256: sha256File(path),
  };
}

function verifiedContributionCount(zkeyVerifyOutput) {
  const numbers = [
    ...zkeyVerifyOutput.matchAll(/\bcontribution\s+#(\d+)\b/gi),
  ].map((match) => Number(match[1]));
  const unique = new Set(numbers.filter((value) => Number.isSafeInteger(value) && value > 0));
  return unique.size;
}

const args = parseArgs(process.argv.slice(2));
const mode = required(args, "mode");
if (mode !== "production" && mode !== "ci-validation") {
  throw new Error("--mode must be production or ci-validation");
}

const circuit = required(args, "circuit");
if (circuit !== "CapacitySpend" && circuit !== "CapacityRelease") {
  throw new Error("--circuit must be CapacitySpend or CapacityRelease");
}

const r1csPath = resolve(required(args, "r1cs"));
const ptauPath = resolve(required(args, "ptau"));
const zkeyPath = resolve(required(args, "zkey"));
const outDir = resolve(required(args, "out-dir"));
const minimumContributionCount = Number(args.get("min-contributions") ?? "1");
if (!Number.isSafeInteger(minimumContributionCount) || minimumContributionCount < 1) {
  throw new Error("--min-contributions must be a positive integer");
}

const ceremonyId = args.get("ceremony-id")?.trim() || (mode === "ci-validation" ? "ci-validation" : "");
const sourceCommit =
  args.get("source-commit")?.trim() ||
  (mode === "ci-validation" ? process.env.GITHUB_SHA?.trim() || "local-ci-validation" : "");

if (mode === "production") {
  if (!ceremonyId || ceremonyId === "REPLACE_ME") {
    throw new Error("Production verification requires a non-placeholder --ceremony-id");
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit) || /^0{40}$/i.test(sourceCommit)) {
    throw new Error("Production verification requires --source-commit as a non-zero exact 40-hex canonical commit SHA");
  }
}

for (const path of [r1csPath, ptauPath, zkeyPath]) artifact(path);
mkdirSync(outDir, { recursive: true });

const verificationKeyPath = join(outDir, `${circuit}_verification_key.json`);
const solidityVerifierPath = join(outDir, `${circuit}Verifier.sol`);
const evidencePath = join(outDir, `${circuit}_ceremony_evidence.json`);
const evidenceChecksumPath = `${evidencePath}.sha256`;

runSnarkjs(["powersoftau", "verify", ptauPath]);
const zkeyVerifyOutput = runSnarkjs(["zkey", "verify", r1csPath, ptauPath, zkeyPath]);
if (!/ZKey Ok!/i.test(zkeyVerifyOutput)) {
  throw new Error("snarkjs zkey verify exited successfully but did not report ZKey Ok!");
}

const contributionCount = verifiedContributionCount(zkeyVerifyOutput);
if (contributionCount < minimumContributionCount) {
  throw new Error(
    `Verified zkey transcript contains ${contributionCount} Phase-2 contribution(s); at least ${minimumContributionCount} required`,
  );
}

runSnarkjs(["zkey", "export", "verificationkey", zkeyPath, verificationKeyPath]);
runSnarkjs(["zkey", "export", "solidityverifier", zkeyPath, solidityVerifierPath]);
const snarkjsVersion = installedSnarkjsVersion();

const evidence = {
  schemaVersion: 1,
  format: "threadproof-groth16-ceremony-evidence/v1",
  mode,
  circuit,
  circuitVersion: 1,
  ceremonyId,
  sourceCommit,
  verification: {
    powersOfTauVerified: true,
    finalZkeyVerified: true,
    phase2ContributionCount: contributionCount,
    minimumPhase2ContributionCount: minimumContributionCount,
  },
  artifacts: {
    r1cs: artifact(r1csPath),
    powersOfTau: artifact(ptauPath),
    finalZkey: artifact(zkeyPath),
    verificationKey: artifact(verificationKeyPath),
    solidityVerifier: artifact(solidityVerifierPath),
  },
  tooling: {
    snarkjsVersion,
  },
  generatedAt: new Date().toISOString(),
  handling: {
    participantEntropyAcceptedByThisTool: false,
    participantPrivateMaterialPersistedByThisTool: false,
    finalZkeyCopiedByThisTool: false,
    note: "This verifier consumes finalized ceremony artifacts only. Ceremony contributions and participant entropy must be created outside this repository workflow.",
  },
};

const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
writeFileSync(evidencePath, evidenceBytes, { mode: 0o644 });
const evidenceSha256 = `0x${createHash("sha256").update(evidenceBytes).digest("hex")}`;
writeFileSync(
  evidenceChecksumPath,
  `${evidenceSha256.slice(2)}  ${basename(evidencePath)}\n`,
  { mode: 0o644 },
);

console.log(
  `THREADPROOF_PRODUCTION_CEREMONY_EVIDENCE ${JSON.stringify({
    circuit,
    mode,
    phase2ContributionCount: contributionCount,
    evidencePath,
    evidenceSha256,
    verificationKeyPath,
    solidityVerifierPath,
  })}`,
);
