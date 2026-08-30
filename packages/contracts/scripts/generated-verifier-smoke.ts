import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ORDER_TYPES = {
  OrderVersion: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "primaryFactoryOrganizationId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "previousVersionHash", type: "bytes32" },
    { name: "orderCommitment", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

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

function scalar(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed >= SNARK_SCALAR_FIELD) throw new Error(`${label} is outside the BN254 scalar field`);
  return parsed;
}

function fieldBytes32(value: bigint): string {
  if (value < 0n || value >= SNARK_SCALAR_FIELD) throw new Error("Cannot encode an out-of-field identifier");
  return ethers.toBeHex(value, 32);
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
    a: [scalar(piA[0], "proof.pi_a[0]"), scalar(piA[1], "proof.pi_a[1]")] as [bigint, bigint],
    // SnarkJS proof JSON uses the opposite Fq2 coordinate order from Solidity calldata.
    b: [
      [scalar(b0[1], "proof.pi_b[0][1]"), scalar(b0[0], "proof.pi_b[0][0]")],
      [scalar(b1[1], "proof.pi_b[1][1]"), scalar(b1[0], "proof.pi_b[1][0]")],
    ] as [[bigint, bigint], [bigint, bigint]],
    c: [scalar(piC[0], "proof.pi_c[0]"), scalar(piC[1], "proof.pi_c[1]")] as [bigint, bigint],
  };
}

function loadPublicSignals(publicPath: string) {
  const raw = asArray(readJson(publicPath), "public signals");
  if (raw.length !== 9) throw new Error(`Expected nine CapacitySpend public signals, received ${raw.length}`);
  return raw.map((value, index) => scalar(value, `publicSignals[${index}]`)) as [
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
    process.env.THREADPROOF_GENERATED_PROOF_DIR ?? "../circuits/artifacts"
  );
  const verifierSourcePath = path.resolve(
    process.env.THREADPROOF_GENERATED_VERIFIER_SOL ?? "contracts/generated/CapacitySpendVerifier.sol"
  );
  const verifierSource = readFileSync(verifierSourcePath, "utf8");
  const contractNames = [...verifierSource.matchAll(/\bcontract\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)].map(
    (match) => match[1]
  );
  if (contractNames.length !== 1 || !contractNames[0] || !verifierSource.includes("verifyProof")) {
    throw new Error("Expected exactly one generated Solidity verifier contract exposing verifyProof");
  }

  const proof = loadProof(path.join(proofDir, "proof.json"));
  const publicSignals = loadPublicSignals(path.join(proofDir, "public.json"));

  const [admin, buyerSigner, factorySigner, auditorSigner, relayer] = await ethers.getSigners();
  const GeneratedVerifier = await ethers.getContractFactory(contractNames[0]);
  const verifier = await GeneratedVerifier.deploy();
  await verifier.waitForDeployment();

  assert.equal(
    await verifier.verifyProof(proof.a, proof.b, proof.c, publicSignals),
    true,
    "Generated Solidity verifier rejected its matching development proof"
  );

  const tamperedSignals = [...publicSignals] as typeof publicSignals;
  tamperedSignals[8] = (tamperedSignals[8] + 1n) % SNARK_SCALAR_FIELD;
  assert.notEqual(tamperedSignals[8], publicSignals[8]);
  assert.equal(
    await verifier.verifyProof(proof.a, proof.b, proof.c, tamperedSignals),
    false,
    "Generated Solidity verifier accepted a tampered nullifier signal"
  );

  const factoryId = fieldBytes32(publicSignals[0]);
  const periodId = fieldBytes32(publicSignals[1]);
  const processId = fieldBytes32(publicSignals[2]);
  const orderId = fieldBytes32(publicSignals[3]);
  const policyHash = fieldBytes32(publicSignals[4]);
  const buyerId = ethers.keccak256(ethers.toUtf8Bytes("generated-verifier-smoke-buyer"));
  const auditorId = ethers.keccak256(ethers.toUtf8Bytes("generated-verifier-smoke-auditor"));

  const Registry = await ethers.getContractFactory("ThreadProofRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  await (await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash)).wait();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
  await credentials.waitForDeployment();
  await (await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address)).wait();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault");
  const vault = await CapacityVault.deploy(
    admin.address,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress()
  );
  await vault.waitForDeployment();
  await (await vault.registerVerifier(1, await verifier.getAddress())).wait();
  await (await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorSigner.address)).wait();

  const credentialId = ethers.keccak256(
    ethers.toUtf8Bytes("generated-verifier-smoke-capacity-credential")
  );
  const scopeHash = await vault.capacityCredentialScopeHash(
    factoryId,
    periodId,
    processId,
    policyHash,
    publicSignals[5]
  );
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Hardhat did not return a latest block");
  const now = BigInt(latest.timestamp);

  await (
    await credentials.connect(auditorSigner).issueCredential(
      credentialId,
      factoryId,
      await vault.CAPACITY_CREDENTIAL_TYPE(),
      ethers.keccak256(ethers.toUtf8Bytes("generated-verifier-smoke-credential-body")),
      scopeHash,
      now - 60n,
      now + 86_400n
    )
  ).wait();

  await (
    await vault.connect(auditorSigner).certifyCapacity(
      factoryId,
      periodId,
      processId,
      publicSignals[5],
      credentialId,
      policyHash,
      1
    )
  ).wait();

  const network = await ethers.provider.getNetwork();
  const orderDomain = {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId: network.chainId,
    verifyingContract: await orders.getAddress(),
  };
  const authorization = {
    orderId,
    buyerOrganizationId: buyerId,
    primaryFactoryOrganizationId: factoryId,
    version: 1,
    previousVersionHash: ethers.ZeroHash,
    orderCommitment: publicSignals[7],
    policyHash,
    nonce: await orders.nonces(buyerId),
    deadline: now + 3_600n,
  };
  const buyerSignature = await buyerSigner.signTypedData(orderDomain, ORDER_TYPES, authorization);
  await (await orders.connect(relayer).submitOrderVersion(authorization, buyerSignature)).wait();

  const spendRequest = {
    factoryOrganizationId: factoryId,
    periodId,
    processId,
    orderId,
    policyHash,
    oldCapacityCommitment: publicSignals[5],
    newCapacityCommitment: publicSignals[6],
    orderCommitment: publicSignals[7],
    nullifier: publicSignals[8],
    circuitVersion: 1,
  };
  await (await vault.connect(factorySigner).spendCapacity(spendRequest, proof.a, proof.b, proof.c)).wait();

  const state = await vault.getCapacityState(factoryId, periodId, processId);
  assert.equal(
    state.activeCommitment,
    publicSignals[6],
    "CapacityVault did not advance to the proof's new commitment"
  );
  assert.equal(
    await vault.usedNullifiers(publicSignals[8]),
    true,
    "CapacityVault did not consume the proof nullifier"
  );

  console.log(
    `THREADPROOF_GENERATED_VERIFIER_SMOKE ${JSON.stringify({
      verifierContract: contractNames[0],
      publicSignals: publicSignals.length,
      circuitVersion: 1,
      stateAdvanced: true,
      tamperedSignalRejected: true,
      setup: "development-only-groth16",
    })}`
  );
  console.warn(
    "DEV ONLY: this verifies circuit-to-EVM compatibility for the CI ceremony; it is not a production trusted setup."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
