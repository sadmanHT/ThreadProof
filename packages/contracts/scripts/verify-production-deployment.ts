import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

type ContractManifestEntry = {
  name: string;
  address: string;
  runtimeCodeHash: string;
};

type VerifierManifestEntry = {
  circuitVersion: number;
  address: string;
  circuitArtifactHash: string;
  verificationKeyHash: string;
  runtimeCodeHash: string;
  setup: string;
};

type ReleaseManifest = {
  schemaVersion: number;
  release: {
    version: string;
    sourceDevelopCommit: string;
  };
  chain: {
    networkName: string;
    chainId: number;
    genesisHash: string;
    validatorCount: number;
  };
  contracts: ContractManifestEntry[];
  verifiers: {
    capacitySpend: VerifierManifestEntry;
    capacityRelease: VerifierManifestEntry;
  };
};

const provenanceAbi = [
  "function getVerifierProvenance(uint32 circuitVersion) view returns (tuple(address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt))",
  "function getReleaseVerifierProvenance(uint32 circuitVersion) view returns (tuple(address verifier, bytes32 circuitArtifactHash, bytes32 verificationKeyHash, bytes32 verifierCodeHash, uint64 registeredAt))",
] as const;

function fail(message: string): never {
  throw new Error(`Production deployment verification failed: ${message}`);
}

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function requireEqual(actual: string, expected: string, label: string) {
  if (!sameHex(actual, expected)) {
    fail(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

async function runtimeCodeHash(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") fail(`${label} has no deployed runtime bytecode at ${address}`);
  return ethers.keccak256(code);
}

function loadManifest() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const manifestPath = path.resolve(
    repoRoot,
    process.env.THREADPROOF_RELEASE_MANIFEST ?? "release/production-release.json",
  );
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as ReleaseManifest;
  return {
    manifest,
    manifestPath,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

async function main() {
  const { manifest, manifestPath, manifestSha256 } = loadManifest();

  if (manifest.schemaVersion !== 1) fail("unsupported release manifest schema.");
  if (manifest.chain.chainId !== 2026) fail(`manifest chain ID must be 2026, got ${manifest.chain.chainId}.`);

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== BigInt(manifest.chain.chainId)) {
    fail(`RPC chain ID ${network.chainId.toString()} does not match manifest ${manifest.chain.chainId}.`);
  }

  const genesis = await ethers.provider.getBlock(0);
  if (!genesis?.hash) fail("RPC did not return canonical genesis block 0.");
  requireEqual(genesis.hash, manifest.chain.genesisHash, "genesis hash");

  const codeEvidence: Record<string, { address: string; runtimeCodeHash: string }> = {};
  for (const entry of manifest.contracts) {
    if (!ethers.isAddress(entry.address)) fail(`${entry.name} has an invalid address in the manifest.`);
    const actualHash = await runtimeCodeHash(entry.address, entry.name);
    requireEqual(actualHash, entry.runtimeCodeHash, `${entry.name} runtime code hash`);
    codeEvidence[entry.name] = { address: entry.address, runtimeCodeHash: actualHash };
  }

  const vaultEntry = manifest.contracts.find((entry) => entry.name === "CapacityVault");
  if (!vaultEntry) fail("CapacityVault is missing from the release manifest.");

  const vault = new ethers.Contract(vaultEntry.address, provenanceAbi, ethers.provider);
  const verifierEvidence: Record<string, unknown> = {};

  for (const [kind, verifier, functionName] of [
    ["capacitySpend", manifest.verifiers.capacitySpend, "getVerifierProvenance"],
    ["capacityRelease", manifest.verifiers.capacityRelease, "getReleaseVerifierProvenance"],
  ] as const) {
    if (verifier.setup !== "production-ceremony") {
      fail(`${kind} verifier is not marked as production-ceremony.`);
    }
    if (!ethers.isAddress(verifier.address)) fail(`${kind} verifier address is invalid.`);

    const actualVerifierCodeHash = await runtimeCodeHash(verifier.address, `${kind} verifier`);
    requireEqual(actualVerifierCodeHash, verifier.runtimeCodeHash, `${kind} verifier runtime code hash`);

    const provenance = await vault[functionName](verifier.circuitVersion);
    requireEqual(String(provenance.verifier), verifier.address, `${kind} provenance verifier address`);
    requireEqual(String(provenance.circuitArtifactHash), verifier.circuitArtifactHash, `${kind} circuit artifact hash`);
    requireEqual(String(provenance.verificationKeyHash), verifier.verificationKeyHash, `${kind} verification key hash`);
    requireEqual(String(provenance.verifierCodeHash), verifier.runtimeCodeHash, `${kind} registered verifier code hash`);

    verifierEvidence[kind] = {
      circuitVersion: verifier.circuitVersion,
      address: verifier.address,
      runtimeCodeHash: actualVerifierCodeHash,
      circuitArtifactHash: String(provenance.circuitArtifactHash),
      verificationKeyHash: String(provenance.verificationKeyHash),
      registeredAt: String(provenance.registeredAt),
    };
  }

  console.log(
    `THREADPROOF_PRODUCTION_DEPLOYMENT_VERIFIED ${JSON.stringify({
      release: manifest.release.version,
      sourceDevelopCommit: manifest.release.sourceDevelopCommit,
      manifestFile: path.relative(path.resolve(__dirname, "../../.."), manifestPath),
      manifestSha256,
      chainId: network.chainId.toString(),
      genesisHash: genesis.hash,
      validatorCountAttested: manifest.chain.validatorCount,
      contracts: codeEvidence,
      verifiers: verifierEvidence,
    })}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
