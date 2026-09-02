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
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUIRED_CIRCOM_VERSION = "2.2.0";
const REQUIRED_PNPM_VERSION = "10.15.0";
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
    env: options.env ?? process.env,
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

function isPathWithin(basePath, candidatePath) {
  const value = relative(basePath, candidatePath);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function normalizedRepoPath(repoRoot, path) {
  const value = relative(repoRoot, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value === "..") {
    throw new Error(`Build input is outside the repository working tree: ${path}`);
  }
  return value;
}

function normalizedCircuitInputPath(repoRoot, isolatedNodeModules, path) {
  if (isPathWithin(repoRoot, path)) return normalizedRepoPath(repoRoot, path);
  if (isPathWithin(isolatedNodeModules, path)) {
    return `isolated-node_modules/${relative(isolatedNodeModules, path).split(sep).join("/")}`;
  }
  throw new Error(`Circuit dependency is outside trusted source and isolated dependency roots: ${path}`);
}

function resolveInclude(specifier, currentPath, isolatedNodeModules) {
  const candidates = [
    resolve(dirname(currentPath), specifier),
    resolve(isolatedNodeModules, specifier),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Could not resolve Circom include ${specifier} from ${currentPath}`);
}

function collectCircuitClosure(rootSource, repoRoot, isolatedNodeModules) {
  const visited = new Map();
  const visit = (path) => {
    const logical = normalizedCircuitInputPath(repoRoot, isolatedNodeModules, path);
    if (visited.has(logical)) return;
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    visited.set(logical, {
      path: logical,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes),
    });
    for (const match of text.matchAll(/\binclude\s+"([^"]+)"\s*;/g)) {
      visit(resolveInclude(match[1], path, isolatedNodeModules));
    }
  };
  visit(rootSource);
  return [...visited.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function copyExactFile(sourcePath, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, readFileSync(sourcePath), { mode: 0o644 });
}

function rehydrateCircuitDependencies({ repoRoot, packageRoot, pnpmPath }) {
  const tempRoot = mkdtempSync(join(tmpdir(), "threadproof-circuit-deps-"));
  try {
    const rootManifestPath = resolve(repoRoot, "package.json");
    const workspaceManifestPath = resolve(repoRoot, "pnpm-workspace.yaml");
    const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");
    const circuitManifestPath = resolve(packageRoot, "package.json");

    copyExactFile(rootManifestPath, join(tempRoot, "package.json"));
    copyExactFile(workspaceManifestPath, join(tempRoot, "pnpm-workspace.yaml"));
    copyExactFile(lockfilePath, join(tempRoot, "pnpm-lock.yaml"));
    copyExactFile(circuitManifestPath, join(tempRoot, "packages", "circuits", "package.json"));

    const pnpmVersion = run(pnpmPath, ["--version"]);
    if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
      throw new Error(`pnpm ${REQUIRED_PNPM_VERSION} is required for dependency rehydration; got: ${pnpmVersion}`);
    }

    run(
      pnpmPath,
      [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prod",
        "--filter",
        "@threadproof/circuits...",
      ],
      { cwd: tempRoot },
    );

    const isolatedNodeModules = join(tempRoot, "packages", "circuits", "node_modules");
    if (!existsSync(isolatedNodeModules) || !statSync(isolatedNodeModules).isDirectory()) {
      throw new Error("Frozen-lockfile dependency rehydration did not create the isolated circuit node_modules tree");
    }

    return {
      tempRoot,
      isolatedNodeModules,
      pnpmVersion,
      pnpmExecutable: artifact(pnpmPath),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
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
const pnpmPath = resolveExecutable("pnpm");
const sourcePath = resolve(packageRoot, sourceRelative);
const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");
const packageManifestPath = resolve(packageRoot, "package.json");
const rootManifestPath = resolve(repoRoot, "package.json");
const workspaceManifestPath = resolve(repoRoot, "pnpm-workspace.yaml");
const suppliedR1cs = artifact(r1csPath);

const dependencyWorkspace = rehydrateCircuitDependencies({ repoRoot, packageRoot, pnpmPath });
const rebuildDir = mkdtempSync(join(tmpdir(), `threadproof-${circuit.toLowerCase()}-rebuild-`));
try {
  const sourceClosure = collectCircuitClosure(sourcePath, repoRoot, dependencyWorkspace.isolatedNodeModules);
  if (!sourceClosure.some((entry) => entry.path.startsWith("isolated-node_modules/"))) {
    throw new Error("Circuit dependency closure did not include any frozen-lockfile rehydrated dependency files");
  }

  run(
    compilerPath,
    [
      sourcePath,
      "--r1cs",
      "--wasm",
      "--sym",
      "-o",
      rebuildDir,
      "-l",
      dependencyWorkspace.isolatedNodeModules,
    ],
    { cwd: packageRoot },
  );
  const rebuiltR1csPath = join(rebuildDir, `${circuit}.r1cs`);
  const rebuiltR1cs = artifact(rebuiltR1csPath);
  if (rebuiltR1cs.sha256.toLowerCase() !== suppliedR1cs.sha256.toLowerCase()) {
    throw new Error(
      `Supplied ${circuit} R1CS does not match an isolated frozen-lockfile recompilation from ${sourceCommit}: supplied=${suppliedR1cs.sha256}, rebuilt=${rebuiltR1cs.sha256}`,
    );
  }

  const rebuiltWasmPath = join(rebuildDir, `${circuit}_js`, `${circuit}.wasm`);
  const rebuiltSymPath = join(rebuildDir, `${circuit}.sym`);
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
      dependenciesRehydratedFromFrozenLockfile: true,
      repositoryNodeModulesIgnored: true,
      offlineDependencyInstall: true,
      dependencyInstallScriptsDisabled: true,
      compilerBinaryHashed: true,
      lockfileHashed: true,
    },
    compiler: {
      requiredVersion: REQUIRED_CIRCOM_VERSION,
      versionOutput: compilerVersionOutput,
      pinnedSourceRevision: PINNED_CIRCOM_REVISION,
      executable: compilerArtifact,
    },
    dependencyInstallation: {
      method: "pnpm-offline-frozen-lockfile",
      requiredPnpmVersion: REQUIRED_PNPM_VERSION,
      actualPnpmVersion: dependencyWorkspace.pnpmVersion,
      pnpmExecutable: dependencyWorkspace.pnpmExecutable,
      productionDependencyOnly: true,
      installScriptsEnabled: false,
      repositoryNodeModulesUsed: false,
    },
    inputs: {
      rootPackageManifest: {
        path: normalizedRepoPath(repoRoot, rootManifestPath),
        ...artifact(rootManifestPath),
      },
      workspaceManifest: {
        path: normalizedRepoPath(repoRoot, workspaceManifestPath),
        ...artifact(workspaceManifestPath),
      },
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
    note: "The supplied R1CS was byte-hash matched against a fresh Circom recompilation from the exact clean Git HEAD. Circuit dependencies were rehydrated into a disposable workspace with pnpm --offline --frozen-lockfile --ignore-scripts and the repository node_modules tree was not used for include resolution or compilation.",
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
      pnpmSha256: dependencyWorkspace.pnpmExecutable.sha256,
      dependencyInstallMethod: "pnpm-offline-frozen-lockfile",
      repositoryNodeModulesUsed: false,
      dependencyFileCount: sourceClosure.length,
      attestationPath,
      attestationSha256,
    })}`,
  );
} finally {
  rmSync(rebuildDir, { recursive: true, force: true });
  rmSync(dependencyWorkspace.tempRoot, { recursive: true, force: true });
}
