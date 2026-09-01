import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUIRED_CIRCOM_VERSION = "2.2.0";
const PINNED_CIRCOM_REVISION = "9fd40a34f42912ee52230f8b6a114d78f6df1a48";
const CIRCUIT_SOURCES = Object.freeze({
  CapacitySpend: "circuits/CapacitySpend.circom",
  CapacityRelease: "circuits/CapacityRelease.circom",
});
const ALLOWED_ARGUMENTS = new Set(["mode", "circuit", "r1cs", "out-dir", "source-commit"]);

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Unsupported argument --${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "no status"}):\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function git(repoRoot, args) {
  return run("git", args, { cwd: repoRoot });
}

function sha256Bytes(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(path) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  const bytes = readFileSync(path);
  return {
    filename: basename(path),
    sizeBytes: stat.size,
    sha256: sha256Bytes(bytes),
  };
}

function resolveExecutable(name) {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`Could not resolve executable ${name} from PATH`);
}

function normalizedRepoPath(repoRoot, path) {
  const value = relative(repoRoot, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") {
    throw new Error(`Build input is outside the repository working tree: ${path}`);
  }
  return value;
}

function resolveInclude(specifier, currentPath, packageRoot, repoRoot) {
  const candidates = [
    resolve(dirname(currentPath), specifier),
    resolve(packageRoot, "node_modules", specifier),
    resolve(repoRoot, "node_modules", specifier),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Could not resolve Circom include ${specifier} from ${currentPath}`);
}

function collectCircuitClosure(rootSource, packageRoot, repoRoot) {
  const visited = new Map();
  const visit = (path) => {
    const logical = normalizedRepoPath(repoRoot, path);
    if (visited.has(logical)) return;
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    visited.set(logical, {
      path: logical,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes),
    });
    for (const match of text.matchAll(/\binclude\s+"([^"]+)"\s*;/g)) {
      visit(resolveInclude(match[1], path, packageRoot, repoRoot));
    }
  };
  visit(rootSource);
  return [...visited.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const args = parseArgs(process.argv.slice(2));
const mode = required(args, "mode");
if (mode !== "production" && mode !== "ci-validation") {
  throw new Error("--mode must be production or ci-validation");
}

const circuit = required(args, "circuit");
const sourceRelative = CIRCUIT_SOURCES[circuit];
if (!sourceRelative) throw new Error("--circuit must be CapacitySpend or CapacityRelease");

const r1csPath = resolve(required(args, "r1cs"));
const outDir = resolve(required(args, "out-dir"));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const repoRoot = git(packageRoot, ["rev-parse", "--show-toplevel"]);
const gitHead = git(repoRoot, ["rev-parse", "HEAD"]).toLowerCase();
const sourceCommit = (args.get("source-commit")?.trim() || gitHead).toLowerCase();

if (!/^[0-9a-f]{40}$/i.test(sourceCommit) || /^0{40}$/i.test(sourceCommit)) {
  throw new Error("--source-commit must be a non-zero exact 40-hex commit SHA");
}
if (sourceCommit !== gitHead) {
  throw new Error(`Circuit build verification must run from the exact source commit: HEAD=${gitHead}, requested=${sourceCommit}`);
}
if (mode === "production" && !args.has("source-commit")) {
  throw new Error("Production circuit build verification requires explicit --source-commit");
}

const trackedStatus = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus.length > 0) {
  throw new Error(`Tracked working tree must be clean before circuit build verification:\n${trackedStatus}`);
}
const gitTree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]).toLowerCase();

const compilerPath = resolveExecutable("circom");
const compilerVersionOutput = run(compilerPath, ["--version"]);
if (!compilerVersionOutput.includes(REQUIRED_CIRCOM_VERSION)) {
  throw new Error(`Circom ${REQUIRED_CIRCOM_VERSION} is required; got: ${compilerVersionOutput}`);
}
const compilerArtifact = artifact(compilerPath);
const sourcePath = resolve(packageRoot, sourceRelative);
const sourceClosure = collectCircuitClosure(sourcePath, packageRoot, repoRoot);
const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");
const packageManifestPath = resolve(packageRoot, "package.json");
const suppliedR1cs = artifact(r1csPath);

const tempDir = mkdtempSync(join(tmpdir(), `threadproof-${circuit.toLowerCase()}-rebuild-`));
try {
  run(
    compilerPath,
    [
      sourcePath,
      "--r1cs",
      "--wasm",
      "--sym",
      "-o",
      tempDir,
      "-l",
      resolve(packageRoot, "node_modules"),
    ],
    { cwd: packageRoot },
  );
  const rebuiltR1csPath = join(tempDir, `${circuit}.r1cs`);
  const rebuiltR1cs = artifact(rebuiltR1csPath);
  if (rebuiltR1cs.sha256.toLowerCase() !== suppliedR1cs.sha256.toLowerCase()) {
    throw new Error(
      `Supplied ${circuit} R1CS does not match a clean recompilation from ${sourceCommit}: supplied=${suppliedR1cs.sha256}, rebuilt=${rebuiltR1cs.sha256}`,
    );
  }

  const rebuiltWasmPath = join(tempDir, `${circuit}_js`, `${circuit}.wasm`);
  const rebuiltSymPath = join(tempDir, `${circuit}.sym`);
  const attestation = {
    schemaVersion: 1,
    format: "threadproof-circuit-build-attestation/v1",
    mode,
    circuit,
    circuitVersion: 1,
    sourceCommit,
    gitTree,
    trackedCheckoutClean: true,
    buildVerification: {
      recompiledR1csMatched: true,
      sourceCommitMatchedHead: true,
      dependencyClosureHashed: true,
      compilerBinaryHashed: true,
      lockfileHashed: true,
    },
    compiler: {
      requiredVersion: REQUIRED_CIRCOM_VERSION,
      versionOutput: compilerVersionOutput,
      pinnedSourceRevision: PINNED_CIRCOM_REVISION,
      executable: compilerArtifact,
    },
    inputs: {
      packageManifest: {
        path: normalizedRepoPath(repoRoot, packageManifestPath),
        ...artifact(packageManifestPath),
      },
      lockfile: {
        path: normalizedRepoPath(repoRoot, lockfilePath),
        ...artifact(lockfilePath),
      },
      circuitClosure: sourceClosure,
    },
    artifacts: {
      suppliedR1cs,
      rebuiltR1cs,
      rebuiltWasm: artifact(rebuiltWasmPath),
      rebuiltSym: artifact(rebuiltSymPath),
    },
    generatedAt: new Date().toISOString(),
    note: "The supplied R1CS was byte-hash matched against a fresh Circom recompilation from the exact clean Git HEAD using the recorded compiler binary and recursive include closure.",
  };

  mkdirSync(outDir, { recursive: true });
  const attestationPath = join(outDir, `${circuit}_build_attestation.json`);
  const checksumPath = `${attestationPath}.sha256`;
  const bytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  writeFileSync(attestationPath, bytes, { mode: 0o644 });
  const attestationSha256 = sha256Bytes(bytes);
  writeFileSync(checksumPath, `${attestationSha256.slice(2)}  ${basename(attestationPath)}\n`, { mode: 0o644 });

  console.log(
    `THREADPROOF_CIRCUIT_BUILD_ATTESTATION ${JSON.stringify({
      circuit,
      mode,
      sourceCommit,
      gitTree,
      r1csSha256: suppliedR1cs.sha256,
      compilerSha256: compilerArtifact.sha256,
      dependencyFileCount: sourceClosure.length,
      attestationPath,
      attestationSha256,
    })}`,
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
