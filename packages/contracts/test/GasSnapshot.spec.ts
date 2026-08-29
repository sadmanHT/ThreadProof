import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_A: [bigint, bigint] = [0n, 0n];
const ZERO_B: [[bigint, bigint], [bigint, bigint]] = [[0n, 0n], [0n, 0n]];
const ZERO_C: [bigint, bigint] = [0n, 0n];

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

describe("ThreadProof gas baselines", function () {
  it("records representative core transaction gas without treating it as an optimization target", async function () {
    const [admin, buyerSigner, factorySigner, auditorSigner, relayer] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("gas-buyer"));
    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("gas-factory"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("gas-auditor"));

    const registerReceipt = await (
      await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash)
    ).wait();
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);

    const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
    const orders = await OrderRegistry.deploy(await registry.getAddress());
    await orders.waitForDeployment();

    const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    const Vault = await ethers.getContractFactory("CapacityVault");
    const vault = await Vault.deploy(
      admin.address,
      await credentials.getAddress(),
      await orders.getAddress(),
      await registry.getAddress()
    );
    await vault.waitForDeployment();
    await vault.registerVerifier(1, await verifier.getAddress());
    await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorSigner.address);

    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-10"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("policy-v1"));
    const initialCommitment = 1001n;
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("gas-capacity-credential"));
    const credentialType = await vault.CAPACITY_CREDENTIAL_TYPE();
    const scopeHash = await vault.capacityCredentialScopeHash(
      factoryId,
      periodId,
      processId,
      policyHash,
      initialCommitment
    );
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);

    const credentialReceipt = await (
      await credentials.connect(auditorSigner).issueCredential(
        credentialId,
        factoryId,
        credentialType,
        ethers.keccak256(ethers.toUtf8Bytes("gas-credential-body")),
        scopeHash,
        now - 60n,
        now + 86_400n
      )
    ).wait();

    const certificationReceipt = await (
      await vault.connect(auditorSigner).certifyCapacity(
        factoryId,
        periodId,
        processId,
        initialCommitment,
        credentialId,
        policyHash,
        1
      )
    ).wait();

    const orderId = ethers.keccak256(ethers.toUtf8Bytes("gas-order-1"));
    const orderCommitment = 12_002n;
    const networkInfo = await ethers.provider.getNetwork();
    const domain = {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: networkInfo.chainId,
      verifyingContract: await orders.getAddress(),
    };
    const authorization = {
      orderId,
      buyerOrganizationId: buyerId,
      primaryFactoryOrganizationId: factoryId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment,
      policyHash,
      nonce: 0n,
      deadline: now + 3_600n,
    };
    const signature = await buyerSigner.signTypedData(domain, ORDER_TYPES, authorization);
    const orderReceipt = await (
      await orders.connect(relayer).submitOrderVersion(authorization, signature)
    ).wait();

    const spend = {
      factoryOrganizationId: factoryId,
      periodId,
      processId,
      orderId,
      policyHash,
      oldCapacityCommitment: initialCommitment,
      newCapacityCommitment: 2002n,
      orderCommitment,
      nullifier: 3003n,
      circuitVersion: 1,
    };
    const spendReceipt = await (
      await vault.connect(factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C)
    ).wait();

    const snapshot = {
      registerOrganization: registerReceipt!.gasUsed.toString(),
      issueCredential: credentialReceipt!.gasUsed.toString(),
      submitOrderVersion: orderReceipt!.gasUsed.toString(),
      certifyCapacity: certificationReceipt!.gasUsed.toString(),
      spendCapacityMockVerifier: spendReceipt!.gasUsed.toString(),
    };

    for (const gas of Object.values(snapshot)) {
      expect(BigInt(gas)).to.be.greaterThan(0n);
    }

    console.log(`THREADPROOF_GAS_SNAPSHOT ${JSON.stringify(snapshot)}`);
  });
});
