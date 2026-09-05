import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function decimalUint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function loadProof(proofPath: string) {
  const proof = asRecord(readJson(proofPath), "proof");
  const piA = asArray(proof.pi_a, "proof.pi_a");
  const piB = asArray(proof.pi_b, "proof.pi_b");
  const piC = asArray(proof.pi_c, "proof.pi_c");
  const b0 = asArray(piB[0], "proof.pi_b[0]");
  const b1 = asArray(piB[1], "proof.pi_b[1]");
  if (piA.length < 2 || piC.length < 2 || b0.length < 2 || b1.length < 2) {
    throw new Error("Groth16 proof coordinates are incomplete");
  }
  return {
    a: [decimalUint(piA[0], "proof.pi_a[0]"), decimalUint(piA[1], "proof.pi_a[1]")] as [
      bigint,
      bigint,
    ],
    b: [
      [decimalUint(b0[1], "proof.pi_b[0][1]"), decimalUint(b0[0], "proof.pi_b[0][0]")],
      [decimalUint(b1[1], "proof.pi_b[1][1]"), decimalUint(b1[0], "proof.pi_b[1][0]")],
    ] as [[bigint, bigint], [bigint, bigint]],
    c: [decimalUint(piC[0], "proof.pi_c[0]"), decimalUint(piC[1], "proof.pi_c[1]")] as [
      bigint,
      bigint,
    ],
  };
}

function loadPublicSignals(publicPath: string) {
  const raw = asArray(readJson(publicPath), "public signals");
  if (raw.length !== 9) {
    throw new Error(`Expected nine CapacitySpend public signals, received ${raw.length}`);
  }
  return raw.map((value, index) => decimalUint(value, `publicSignals[${index}]`)) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
}

async function main() {
  const proofDir = path.resolve(
    process.env.THREADPROOF_GENERATED_PROOF_DIR ?? "../circuits/artifacts",
  );
  const proof = loadProof(path.join(proofDir, "proof.json"));
  const publicSignals = loadPublicSignals(path.join(proofDir, "public.json"));

  const [signer] = await ethers.getSigners();
  const Verifier = await ethers.getContractFactory(
    "CapacitySpendVerifierWithProvenance",
    signer,
  );
  const verifier = await Verifier.deploy();
  const deploymentTx = verifier.deploymentTransaction();
  const deploymentReceipt = deploymentTx ? await deploymentTx.wait() : null;
  await verifier.waitForDeployment();

  const verifyProof = verifier.getFunction("verifyProof");
  const verifies = await verifyProof.staticCall(
    proof.a,
    proof.b,
    proof.c,
    publicSignals,
  );
  if (verifies !== true) {
    throw new Error("Generated provenance-bound verifier rejected the canonical proof");
  }

  const estimatedGas = await verifyProof.estimateGas(
    proof.a,
    proof.b,
    proof.c,
    publicSignals,
  );
  const verifierAddress = await verifier.getAddress();
  const calldata = verifier.interface.encodeFunctionData("verifyProof", [
    proof.a,
    proof.b,
    proof.c,
    publicSignals,
  ]);
  const tx = await signer.sendTransaction({
    to: verifierAddress,
    data: calldata,
    gasLimit: estimatedGas + 100_000n,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Verifier benchmark transaction did not finalize successfully");
  }

  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve("..", ".."),
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const result = {
    schemaVersion: 1,
    format: "threadproof-groth16-verifier-gas/v1",
    circuit: "CapacitySpend",
    circuitVersion: 1,
    sourceCommit,
    network: network.name,
    chainId: chainId.toString(),
    verifier: verifierAddress,
    setup: "development-only-groth16",
    measurements: {
      estimateGas: estimatedGas.toString(),
      transactionGasUsed: receipt.gasUsed.toString(),
      deploymentGasUsed: deploymentReceipt?.gasUsed.toString() ?? null,
      calldataBytes: Math.max(0, (calldata.length - 2) / 2),
    },
    canonicalProofVerified: true,
    note:
      "transactionGasUsed is an actual transaction through the provenance-bound Groth16 verifier. It includes transaction intrinsic gas and wrapper-call overhead; estimateGas is the node estimate for the same calldata.",
  };

  mkdirSync(proofDir, { recursive: true });
  const outputPath = path.join(proofDir, "CapacitySpend_verifier_gas.json");
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`THREADPROOF_VERIFIER_GAS ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
