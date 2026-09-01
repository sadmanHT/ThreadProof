import assert from "node:assert/strict";
import { ethers } from "hardhat";
import {
  executeLivePofc,
  ORDER_TYPES,
  SNARK_SCALAR_FIELD,
} from "./lib/live-pofc-context";

const SUBCONTRACT_TYPES = {
  SubcontractAuthorization: [
    { name: "parentOrderId", type: "bytes32" },
    { name: "childOrderId", type: "bytes32" },
    { name: "parentFactoryOrganizationId", type: "bytes32" },
    { name: "subcontractorOrganizationId", type: "bytes32" },
    { name: "periodId", type: "bytes32" },
    { name: "processId", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "parentVersionHash", type: "bytes32" },
    { name: "childVersionHash", type: "bytes32" },
    { name: "complianceCredentialId", type: "bytes32" },
    { name: "processCredentialId", type: "bytes32" },
    { name: "capacityAllocationId", type: "bytes32" },
    { name: "sequence", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

async function main() {
  const pofc = await executeLivePofc();
  const parentFactory = ethers.Wallet.createRandom().connect(pofc.provider);
  await (await pofc.admin.sendTransaction({ to: parentFactory.address, value: ethers.parseEther("2") })).wait();

  const parentFactoryId = ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-parent-factory"));
  await (
    await pofc.registry.registerOrganization(
      parentFactoryId,
      parentFactory.address,
      2,
      ethers.ZeroHash,
    )
  ).wait();

  const Governor = await ethers.getContractFactory("SubcontractGovernor", pofc.admin);
  const governor = await Governor.deploy(
    pofc.adminAddress,
    await pofc.registry.getAddress(),
    await pofc.credentials.getAddress(),
    await pofc.orders.getAddress(),
    await pofc.vault.getAddress(),
  );
  await governor.waitForDeployment();

  const complianceType = ethers.keccak256(ethers.toUtf8Bytes("FACTORY_COMPLIANCE_CREDENTIAL"));
  const processCredentialType = ethers.keccak256(ethers.toUtf8Bytes("PROCESS_CREDENTIAL"));
  const policyTx = await governor.registerPolicy(
    pofc.policyHash,
    3,
    complianceType,
    processCredentialType,
  );
  const policyReceipt = await policyTx.wait();
  assert.equal(policyReceipt?.status, 1);

  const latestForCredentials = await pofc.provider.getBlock("latest");
  if (!latestForCredentials) throw new Error("Live subcontract demo could not read the latest block");
  const credentialNow = BigInt(latestForCredentials.timestamp);
  const complianceCredentialId = ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-compliance-credential"));
  const processCredentialId = ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-process-credential"));

  const complianceTx = await pofc.credentials.connect(pofc.auditor).issueCredential(
    complianceCredentialId,
    pofc.factoryId,
    complianceType,
    ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-compliance-body")),
    await governor.complianceCredentialScopeHash(pofc.factoryId, pofc.policyHash),
    credentialNow - 60n,
    credentialNow + 86_400n,
  );
  const complianceReceipt = await complianceTx.wait();
  assert.equal(complianceReceipt?.status, 1);

  const processTx = await pofc.credentials.connect(pofc.auditor).issueCredential(
    processCredentialId,
    pofc.factoryId,
    processCredentialType,
    ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-process-body")),
    await governor.processCredentialScopeHash(pofc.factoryId, pofc.processId, pofc.policyHash),
    credentialNow - 60n,
    credentialNow + 86_400n,
  );
  const processReceipt = await processTx.wait();
  assert.equal(processReceipt?.status, 1);

  const parentOrderId = ethers.keccak256(ethers.toUtf8Bytes("live-subcontract-parent-order"));
  const parentOrderCommitmentCandidate = (pofc.publicSignals[7] + 1_234_567n) % SNARK_SCALAR_FIELD;
  const parentOrderCommitment = parentOrderCommitmentCandidate === 0n ? 1n : parentOrderCommitmentCandidate;
  const latestForParentOrder = await pofc.provider.getBlock("latest");
  if (!latestForParentOrder) throw new Error("Live subcontract demo could not timestamp the parent order");
  const parentOrderAuthorization = {
    orderId: parentOrderId,
    buyerOrganizationId: pofc.buyerId,
    primaryFactoryOrganizationId: parentFactoryId,
    version: 1,
    previousVersionHash: ethers.ZeroHash,
    orderCommitment: parentOrderCommitment,
    policyHash: pofc.policyHash,
    nonce: await pofc.orders.nonces(pofc.buyerId),
    deadline: BigInt(latestForParentOrder.timestamp) + 3_600n,
  };
  const parentBuyerSignature = await pofc.buyer.signTypedData(
    {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: pofc.chainId,
      verifyingContract: await pofc.orders.getAddress(),
    },
    ORDER_TYPES,
    parentOrderAuthorization,
  );
  const parentOrderTx = await pofc.orders
    .connect(pofc.relayer)
    .submitOrderVersion(parentOrderAuthorization, parentBuyerSignature);
  const parentOrderReceipt = await parentOrderTx.wait();
  assert.equal(parentOrderReceipt?.status, 1);

  const parentState = await pofc.orders.getOrder(parentOrderId);
  const childState = await pofc.orders.getOrder(pofc.orderId);
  assert.equal(childState.buyerOrganizationId, pofc.buyerId);
  assert.equal(childState.primaryFactoryOrganizationId, pofc.factoryId);
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
    true,
    "Child PoFC allocation stopped being current before subcontract authorization",
  );

  const latestForSubcontract = await pofc.provider.getBlock("latest");
  if (!latestForSubcontract) throw new Error("Live subcontract demo could not timestamp authorization");
  const baseAuthorization = {
    parentOrderId,
    childOrderId: pofc.orderId,
    parentFactoryOrganizationId: parentFactoryId,
    subcontractorOrganizationId: pofc.factoryId,
    periodId: pofc.periodId,
    processId: pofc.processId,
    policyHash: pofc.policyHash,
    parentVersionHash: parentState.currentVersionHash,
    childVersionHash: childState.currentVersionHash,
    complianceCredentialId,
    processCredentialId,
    capacityAllocationId: pofc.allocationId,
    sequence: 1,
    nonce: await governor.nonces(parentFactoryId),
    deadline: BigInt(latestForSubcontract.timestamp) + 3_600n,
  };
  const subcontractDomain = {
    name: "ThreadProof SubcontractGovernor",
    version: "1",
    chainId: pofc.chainId,
    verifyingContract: await governor.getAddress(),
  };

  const invalidAuthorization = {
    ...baseAuthorization,
    capacityAllocationId: ethers.keccak256(ethers.toUtf8Bytes("nonexistent-live-subcontract-allocation")),
  };
  const invalidSignature = await parentFactory.signTypedData(
    subcontractDomain,
    SUBCONTRACT_TYPES,
    invalidAuthorization,
  );
  let invalidAllocationRejected = false;
  try {
    await governor
      .connect(pofc.relayer)
      .authorizeSubcontract.staticCall(invalidAuthorization, invalidSignature);
  } catch {
    invalidAllocationRejected = true;
  }
  assert.equal(
    invalidAllocationRejected,
    true,
    "SubcontractGovernor accepted an authorization bound to a nonexistent PoFC allocation",
  );
  assert.equal(await governor.nonces(parentFactoryId), 0n, "Rejected subcontract attempt consumed the parent nonce");

  const parentFactorySignature = await parentFactory.signTypedData(
    subcontractDomain,
    SUBCONTRACT_TYPES,
    baseAuthorization,
  );
  const subcontractTx = await governor
    .connect(pofc.relayer)
    .authorizeSubcontract(baseAuthorization, parentFactorySignature);
  const subcontractReceipt = await subcontractTx.wait();
  assert.equal(subcontractReceipt?.status, 1, "Live subcontract authorization reverted on chain 2026");

  const record = await governor.getSubcontractAuthorization(pofc.orderId);
  assert.equal(record.exists, true);
  assert.equal(record.parentOrderId, parentOrderId);
  assert.equal(record.childOrderId, pofc.orderId);
  assert.equal(record.buyerOrganizationId, pofc.buyerId);
  assert.equal(record.parentFactoryOrganizationId, parentFactoryId);
  assert.equal(record.subcontractorOrganizationId, pofc.factoryId);
  assert.equal(record.capacityAllocationId, pofc.allocationId);
  assert.equal(record.capacityNullifier, pofc.publicSignals[8]);
  assert.equal(record.depth, 1n);
  assert.equal(record.sequence, 1n);
  assert.equal(record.parentSigner.toLowerCase(), parentFactory.address.toLowerCase());
  assert.equal(await governor.nonces(parentFactoryId), 1n);
  assert.equal(
    await governor.isSubcontractAuthorizationActive(pofc.orderId),
    true,
    "New subcontract authorization is not active under current order/credential/capacity state",
  );

  console.log(
    `THREADPROOF_LIVE_SUBCONTRACT ${JSON.stringify({
      chainId: pofc.chainId.toString(),
      parentOrderId,
      childOrderId: pofc.orderId,
      parentFactoryId,
      subcontractorFactoryId: pofc.factoryId,
      childPofcSpendTx: pofc.spendReceipt?.hash,
      childCapacityAllocationId: pofc.allocationId,
      complianceCredentialTx: complianceReceipt?.hash,
      processCredentialTx: processReceipt?.hash,
      parentOrderTx: parentOrderReceipt?.hash,
      subcontractTx: subcontractReceipt?.hash,
      subcontractBlock: subcontractReceipt?.blockNumber.toString(),
      depth: record.depth.toString(),
      sequence: record.sequence.toString(),
      active: true,
      invalidAllocationRejected,
      setup: "development-only-groth16",
    })}`,
  );
  console.warn(
    "DEV ONLY: this is a real buyer-consented, parent-signed subcontract over a live development PoFC allocation; the Groth16 setup is not production trusted setup.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
