import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { executeLivePofc, SNARK_SCALAR_FIELD } from "./lib/live-pofc-context";

const CANCEL_TYPES = {
  CancelOrder: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "expectedVersion", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

const provenanceVerifierAbi = [
  "function circuitArtifactHash() view returns (bytes32)",
  "function verificationKeyHash() view returns (bytes32)",
  "function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[9] publicSignals) view returns (bool)",
] as const;

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

function bytes32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a bytes32 hex string`);
  }
  return value;
}

function loadProof(proofPath: string) {
  const proof = asRecord(readJson(proofPath), "release proof");
  const piA = asArray(proof.pi_a, "release proof.pi_a");
  const piB = asArray(proof.pi_b, "release proof.pi_b");
  const piC = asArray(proof.pi_c, "release proof.pi_c");
  const b0 = asArray(piB[0], "release proof.pi_b[0]");
  const b1 = asArray(piB[1], "release proof.pi_b[1]");
  if (piA.length < 2 || piC.length < 2 || b0.length < 2 || b1.length < 2) {
    throw new Error("CapacityRelease Groth16 proof coordinates are incomplete");
  }
  return {
    a: [decimalUint(piA[0], "release proof.pi_a[0]"), decimalUint(piA[1], "release proof.pi_a[1]")] as [bigint, bigint],
    b: [
      [decimalUint(b0[1], "release proof.pi_b[0][1]"), decimalUint(b0[0], "release proof.pi_b[0][0]")],
      [decimalUint(b1[1], "release proof.pi_b[1][1]"), decimalUint(b1[0], "release proof.pi_b[1][0]")],
    ] as [[bigint, bigint], [bigint, bigint]],
    c: [decimalUint(piC[0], "release proof.pi_c[0]"), decimalUint(piC[1], "release proof.pi_c[1]")] as [bigint, bigint],
  };
}

function loadPublicSignals(publicPath: string) {
  const raw = asArray(readJson(publicPath), "release public signals");
  if (raw.length !== 9) throw new Error(`Expected nine CapacityRelease public signals, received ${raw.length}`);
  return raw.map((value, index) => fieldScalar(value, `releasePublicSignals[${index}]`)) as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
  ];
}

async function main() {
  const pofc = await executeLivePofc();
  const proofDir = pofc.proofDir;
  const releaseProof = loadProof(path.join(proofDir, "release_proof.json"));
  const releasePublicSignals = loadPublicSignals(path.join(proofDir, "release_public.json"));
  const provenance = asRecord(
    readJson(path.join(proofDir, "release_verifier_provenance.json")),
    "release verifier provenance manifest",
  );
  if (provenance.productionTrustedSetup !== false || provenance.setup !== "development-only-groth16") {
    throw new Error("Live capacity release must use the explicitly development-only provenance manifest");
  }
  const circuitArtifact = asRecord(provenance.circuitArtifact, "release provenance.circuitArtifact");
  const verificationKey = asRecord(provenance.verificationKey, "release provenance.verificationKey");
  const expectedCircuitHash = bytes32(circuitArtifact.keccak256, "release circuit artifact hash");
  const expectedVerificationKeyHash = bytes32(verificationKey.keccak256, "release verification key hash");

  assert.equal(releasePublicSignals[0], pofc.publicSignals[0], "Release factory does not match PoFC factory");
  assert.equal(releasePublicSignals[1], pofc.publicSignals[1], "Release period does not match PoFC period");
  assert.equal(releasePublicSignals[2], pofc.publicSignals[2], "Release process does not match PoFC process");
  assert.equal(releasePublicSignals[3], pofc.publicSignals[3], "Release order does not match PoFC order");
  assert.equal(releasePublicSignals[4], pofc.publicSignals[4], "Release policy does not match PoFC policy");
  assert.equal(
    releasePublicSignals[5],
    pofc.publicSignals[6],
    "Release must open the canonical post-spend capacity commitment",
  );
  assert.equal(
    releasePublicSignals[7],
    pofc.publicSignals[7],
    "Release must restore the exact hidden workload bound to the historical order commitment",
  );

  const GeneratedReleaseVerifier = await ethers.getContractFactory("CapacityReleaseVerifierWithProvenance", pofc.admin);
  const releaseVerifierDeployment = await GeneratedReleaseVerifier.deploy();
  await releaseVerifierDeployment.waitForDeployment();
  const releaseVerifierAddress = await releaseVerifierDeployment.getAddress();
  const releaseVerifier = new ethers.Contract(releaseVerifierAddress, provenanceVerifierAbi, pofc.provider);
  const circuitArtifactHash = releaseVerifier.getFunction("circuitArtifactHash");
  const verificationKeyHash = releaseVerifier.getFunction("verificationKeyHash");
  const verifyProof = releaseVerifier.getFunction("verifyProof");
  assert.equal(await circuitArtifactHash.staticCall(), expectedCircuitHash);
  assert.equal(await verificationKeyHash.staticCall(), expectedVerificationKeyHash);
  assert.equal(
    await verifyProof.staticCall(releaseProof.a, releaseProof.b, releaseProof.c, releasePublicSignals),
    true,
    "Provenance-bound release verifier rejected its matching proof",
  );

  const tamperedReleaseSignals = [...releasePublicSignals] as typeof releasePublicSignals;
  tamperedReleaseSignals[8] = (tamperedReleaseSignals[8] + 1n) % SNARK_SCALAR_FIELD;
  assert.equal(
    await verifyProof.staticCall(releaseProof.a, releaseProof.b, releaseProof.c, tamperedReleaseSignals),
    false,
    "Release verifier accepted a tampered release nullifier signal",
  );

  const registerReleaseVerifierTx = await pofc.vault.registerReleaseVerifier(1, releaseVerifierAddress);
  const registerReleaseVerifierReceipt = await registerReleaseVerifierTx.wait();
  assert.equal(registerReleaseVerifierReceipt?.status, 1);
  const registeredProvenance = await pofc.vault.getReleaseVerifierProvenance(1);
  assert.equal(registeredProvenance.verifier.toLowerCase(), releaseVerifierAddress.toLowerCase());
  assert.equal(registeredProvenance.circuitArtifactHash, expectedCircuitHash);
  assert.equal(registeredProvenance.verificationKeyHash, expectedVerificationKeyHash);

  const releaseRequest = {
    allocationId: pofc.allocationId,
    oldCapacityCommitment: releasePublicSignals[5],
    newCapacityCommitment: releasePublicSignals[6],
    releaseNullifier: releasePublicSignals[8],
    releaseCircuitVersion: 1,
  };

  let prematureReleaseRejected = false;
  try {
    await pofc.vault.connect(pofc.factory).releaseCapacity.staticCall(
      releaseRequest,
      releaseProof.a,
      releaseProof.b,
      releaseProof.c,
    );
  } catch {
    prematureReleaseRejected = true;
  }
  assert.equal(prematureReleaseRejected, true, "Capacity release was accepted while the order allocation was still current");

  const order = await pofc.orders.getOrder(pofc.orderId);
  const latest = await pofc.provider.getBlock("latest");
  if (!latest) throw new Error("Live release chain did not return a latest block");
  const cancellation = {
    orderId: pofc.orderId,
    buyerOrganizationId: pofc.buyerId,
    expectedVersion: Number(order.currentVersion),
    nonce: await pofc.orders.nonces(pofc.buyerId),
    deadline: BigInt(latest.timestamp) + 3_600n,
  };
  const orderDomain = {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId: pofc.chainId,
    verifyingContract: await pofc.orders.getAddress(),
  };
  const cancellationSignature = await pofc.buyer.signTypedData(orderDomain, CANCEL_TYPES, cancellation);
  const cancelTx = await pofc.orders.connect(pofc.relayer).cancelOrder(cancellation, cancellationSignature);
  const cancelReceipt = await cancelTx.wait();
  assert.equal(cancelReceipt?.status, 1);
  assert.equal(
    await pofc.vault.isCapacityAllocationAuthorized(
      pofc.allocationId,
      pofc.orderId,
      pofc.factoryId,
      pofc.periodId,
      pofc.processId,
      pofc.publicSignals[7],
      pofc.policyHash,
    ),
    false,
    "Cancelled order unexpectedly retained capacity-allocation authorization",
  );

  const releaseTx = await pofc.vault.connect(pofc.factory).releaseCapacity(
    releaseRequest,
    releaseProof.a,
    releaseProof.b,
    releaseProof.c,
  );
  const releaseReceipt = await releaseTx.wait();
  assert.equal(releaseReceipt?.status, 1, "Capacity release reverted on chain 2026");

  const state = await pofc.vault.getCapacityState(pofc.factoryId, pofc.periodId, pofc.processId);
  assert.equal(state.activeCommitment, releasePublicSignals[6], "Release did not advance the canonical capacity commitment");
  assert.equal(await pofc.vault.releasedAllocations(pofc.allocationId), true, "Allocation was not marked released");
  assert.equal(
    await pofc.vault.usedReleaseNullifiers(releasePublicSignals[8]),
    true,
    "Release nullifier was not consumed",
  );
  const releaseRecord = await pofc.vault.getCapacityRelease(pofc.allocationId);
  assert.equal(releaseRecord.previousCommitment, releasePublicSignals[5]);
  assert.equal(releaseRecord.restoredCommitment, releasePublicSignals[6]);
  assert.equal(releaseRecord.releaseNullifier, releasePublicSignals[8]);

  let replayRejected = false;
  try {
    await pofc.vault.connect(pofc.factory).releaseCapacity.staticCall(
      releaseRequest,
      releaseProof.a,
      releaseProof.b,
      releaseProof.c,
    );
  } catch {
    replayRejected = true;
  }
  assert.equal(replayRejected, true, "Released allocation was replayable");

  console.log(
    `THREADPROOF_LIVE_CAPACITY_RELEASE ${JSON.stringify({
      chainId: pofc.chainId.toString(),
      allocationId: pofc.allocationId,
      spendTx: pofc.spendReceipt?.hash,
      cancelTx: cancelReceipt?.hash,
      releaseVerifier: releaseVerifierAddress,
      releaseCircuitArtifactHash: expectedCircuitHash,
      releaseVerificationKeyHash: expectedVerificationKeyHash,
      releaseVerifierRegistrationTx: registerReleaseVerifierReceipt?.hash,
      releaseTx: releaseReceipt?.hash,
      releaseBlock: releaseReceipt?.blockNumber.toString(),
      postSpendCommitment: releasePublicSignals[5].toString(),
      restoredCommitment: releasePublicSignals[6].toString(),
      releaseNullifier: releasePublicSignals[8].toString(),
      prematureReleaseRejected,
      replayRejected,
      tamperedReleaseSignalRejected: true,
      setup: "development-only-groth16",
    })}`,
  );
  console.warn(
    "DEV ONLY: this is a real PoFC spend, buyer cancellation, and Groth16 capacity-release transition on chain 2026; both ceremonies are development-only.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
