import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

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

function decimalUint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function fieldScalar(value: unknown, label: string): bigint {
  const parsed = decimalUint(value, label);
  if (parsed >= SNARK_SCALAR_FIELD) throw new Error(`${label} is outside the BN254 scalar field`);
  return parsed;
}

function fieldBytes32(value: bigint): string {
  if (value < 0n || value >= SNARK_SCALAR_FIELD) throw new Error("Cannot encode an out-of-field identifier");
  return ethers.toBeHex(value, 32);
}

function bytes32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a bytes32 hex string`);
  }
  return value;
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
    a: [decimalUint(piA[0], "proof.pi_a[0]"), decimalUint(piA[1], "proof.pi_a[1]")] as [bigint, bigint],
    b: [
      [decimalUint(b0[1], "proof.pi_b[0][1]"), decimalUint(b0[0], "proof.pi_b[0][0]")],
      [decimalUint(b1[1], "proof.pi_b[1][1]"), decimalUint(b1[0], "proof.pi_b[1][0]")],
    ] as [[bigint, bigint], [bigint, bigint]],
    c: [decimalUint(piC[0], "proof.pi_c[0]"), decimalUint(piC[1], "proof.pi_c[1]")] as [bigint, bigint],
  };
}

function loadPublicSignals(publicPath: string) {
  const raw = asArray(readJson(publicPath), "public signals");
  if (raw.length !== 9) throw new Error(`Expected nine CapacitySpend public signals, received ${raw.length}`);
  return raw.map((value, index) => fieldScalar(value, `publicSignals[${index}]`)) as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
}

async function main() {
  const proofDir = path.resolve(process.env.THREADPROOF_GENERATED_PROOF_DIR ?? "../circuits/artifacts");
  const provenancePath = path.join(proofDir, "verifier_provenance.json");
  const provenanceManifest = asRecord(readJson(provenancePath), "verifier provenance manifest");
  if (provenanceManifest.productionTrustedSetup !== false || provenanceManifest.setup !== "development-only-groth16") {
    throw new Error("Live pilot PoFC must use the explicitly development-only provenance manifest");
  }
  const circuitArtifact = asRecord(provenanceManifest.circuitArtifact, "provenance.circuitArtifact");
  const verificationKey = asRecord(provenanceManifest.verificationKey, "provenance.verificationKey");
  const expectedCircuitHash = bytes32(circuitArtifact.keccak256, "circuit artifact hash");
  const expectedVerificationKeyHash = bytes32(verificationKey.keccak256, "verification key hash");

  const proof = loadProof(path.join(proofDir, "proof.json"));
  const publicSignals = loadPublicSignals(path.join(proofDir, "public.json"));

  const chainIdHex = (await network.provider.send("eth_chainId")) as string;
  const chainId = BigInt(chainIdHex);
  if (chainId !== 2026n) throw new Error(`Live PoFC must run on ThreadProof chain 2026; received ${chainId}`);

  const provider = new ethers.BrowserProvider(network.provider as never);
  const admin = await provider.getSigner(0);
  const adminAddress = await admin.getAddress();
  const buyer = ethers.Wallet.createRandom().connect(provider);
  const factory = ethers.Wallet.createRandom().connect(provider);
  const auditor = ethers.Wallet.createRandom().connect(provider);
  const relayer = ethers.Wallet.createRandom().connect(provider);

  for (const wallet of [buyer, factory, auditor, relayer]) {
    await (await admin.sendTransaction({ to: wallet.address, value: ethers.parseEther("2") })).wait();
  }

  const GeneratedVerifier = await ethers.getContractFactory("CapacitySpendVerifierWithProvenance", admin);
  const generatedVerifier = await GeneratedVerifier.deploy();
  await generatedVerifier.waitForDeployment();
  const verifierAddress = await generatedVerifier.getAddress();
  assert.equal(await generatedVerifier.circuitArtifactHash(), expectedCircuitHash);
  assert.equal(await generatedVerifier.verificationKeyHash(), expectedVerificationKeyHash);
  assert.equal(
    await generatedVerifier.verifyProof.staticCall(proof.a, proof.b, proof.c, publicSignals),
    true,
    "Provenance-bound verifier rejected its matching proof on chain 2026",
  );
  const tamperedSignals = [...publicSignals] as typeof publicSignals;
  tamperedSignals[8] = (tamperedSignals[8] + 1n) % SNARK_SCALAR_FIELD;
  assert.equal(
    await generatedVerifier.verifyProof.staticCall(proof.a, proof.b, proof.c, tamperedSignals),
    false,
    "Provenance-bound verifier accepted a tampered nullifier signal",
  );

  const factoryId = fieldBytes32(publicSignals[0]);
  const periodId = fieldBytes32(publicSignals[1]);
  const processId = fieldBytes32(publicSignals[2]);
  const orderId = fieldBytes32(publicSignals[3]);
  const policyHash = fieldBytes32(publicSignals[4]);
  const buyerId = ethers.keccak256(ethers.toUtf8Bytes("live-pofc-buyer"));
  const auditorId = ethers.keccak256(ethers.toUtf8Bytes("live-pofc-auditor"));

  const Registry = await ethers.getContractFactory("ThreadProofRegistry", admin);
  const registry = await Registry.deploy(adminAddress);
  await registry.waitForDeployment();
  await (await registry.registerOrganization(buyerId, buyer.address, 1, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(factoryId, factory.address, 2, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(auditorId, auditor.address, 3, ethers.ZeroHash)).wait();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry", admin);
  const credentials = await CredentialRegistry.deploy(adminAddress, await registry.getAddress());
  await credentials.waitForDeployment();
  await (await credentials.grantRole(await credentials.ISSUER_ROLE(), auditor.address)).wait();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry", admin);
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault", admin);
  const vault = await CapacityVault.deploy(
    adminAddress,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress(),
  );
  await vault.waitForDeployment();
  await (await vault.registerVerifier(1, verifierAddress)).wait();
  await (await vault.grantRole(await vault.CERTIFIER_ROLE(), auditor.address)).wait();

  const registeredProvenance = await vault.getVerifierProvenance(1);
  assert.equal(registeredProvenance.verifier.toLowerCase(), verifierAddress.toLowerCase());
  assert.equal(registeredProvenance.circuitArtifactHash, expectedCircuitHash);
  assert.equal(registeredProvenance.verificationKeyHash, expectedVerificationKeyHash);
  const deployedVerifierCode = await provider.getCode(verifierAddress);
  assert.notEqual(deployedVerifierCode, "0x");
  assert.equal(registeredProvenance.verifierCodeHash, ethers.keccak256(deployedVerifierCode));

  const credentialId = ethers.keccak256(ethers.toUtf8Bytes("live-pofc-capacity-credential"));
  const scopeHash = await vault.capacityCredentialScopeHash(
    factoryId,
    periodId,
    processId,
    policyHash,
    publicSignals[5],
  );
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Live chain did not return a latest block");
  const now = BigInt(latest.timestamp);

  const credentialTx = await credentials.connect(auditor).issueCredential(
    credentialId,
    factoryId,
    await vault.CAPACITY_CREDENTIAL_TYPE(),
    ethers.keccak256(ethers.toUtf8Bytes("live-pofc-credential-body")),
    scopeHash,
    now - 60n,
    now + 86_400n,
  );
  const credentialReceipt = await credentialTx.wait();
  assert.equal(credentialReceipt?.status, 1);

  const certifyTx = await vault.connect(auditor).certifyCapacity(
    factoryId,
    periodId,
    processId,
    publicSignals[5],
    credentialId,
    policyHash,
    1,
  );
  const certifyReceipt = await certifyTx.wait();
  assert.equal(certifyReceipt?.status, 1);

  const orderDomain = {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId,
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
  const buyerSignature = await buyer.signTypedData(orderDomain, ORDER_TYPES, authorization);
  const orderTx = await orders.connect(relayer).submitOrderVersion(authorization, buyerSignature);
  const orderReceipt = await orderTx.wait();
  assert.equal(orderReceipt?.status, 1);
  assert.equal(
    await orders.isCurrentOrderAuthorization(orderId, factoryId, publicSignals[7], policyHash),
    true,
    "Buyer-authorized order context is not current before PoFC spend",
  );

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
  const spendTx = await vault.connect(factory).spendCapacity(spendRequest, proof.a, proof.b, proof.c);
  const spendReceipt = await spendTx.wait();
  assert.equal(spendReceipt?.status, 1, "PoFC capacity spend reverted on chain 2026");

  const state = await vault.getCapacityState(factoryId, periodId, processId);
  assert.equal(state.activeCommitment, publicSignals[6], "PoFC did not advance the canonical capacity commitment");
  assert.equal(await vault.usedNullifiers(publicSignals[8]), true, "PoFC did not consume the nullifier");

  const stateKey = await vault.capacityStateKey(factoryId, periodId, processId);
  const allocationId = await vault.capacityAllocationId(stateKey, orderId, publicSignals[8]);
  const allocation = await vault.getCapacityAllocation(allocationId);
  assert.equal(allocation.exists, true);
  assert.equal(allocation.orderId, orderId);
  assert.equal(allocation.orderCommitment, publicSignals[7]);
  assert.equal(
    await vault.isCapacityAllocationAuthorized(
      allocationId,
      orderId,
      factoryId,
      periodId,
      processId,
      publicSignals[7],
      policyHash,
    ),
    true,
    "Recorded PoFC allocation is not currently authorized",
  );

  console.log(
    `THREADPROOF_LIVE_POFC ${JSON.stringify({
      chainId: chainId.toString(),
      verifier: verifierAddress,
      circuitArtifactHash: expectedCircuitHash,
      verificationKeyHash: expectedVerificationKeyHash,
      credentialTx: credentialReceipt?.hash,
      certificationTx: certifyReceipt?.hash,
      orderTx: orderReceipt?.hash,
      spendTx: spendReceipt?.hash,
      spendBlock: spendReceipt?.blockNumber.toString(),
      allocationId,
      oldCommitment: publicSignals[5].toString(),
      newCommitment: publicSignals[6].toString(),
      nullifier: publicSignals[8].toString(),
      allocationAuthorized: true,
      tamperedSignalRejected: true,
      setup: "development-only-groth16",
    })}`,
  );
  console.warn(
    "DEV ONLY: this is a real multi-validator PoFC transaction using a development Groth16 ceremony, not a production trusted setup.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
