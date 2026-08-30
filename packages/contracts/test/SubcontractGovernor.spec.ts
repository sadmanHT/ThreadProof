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

const CANCEL_TYPES = {
  CancelOrder: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "expectedVersion", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

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

describe("SubcontractGovernor", function () {
  async function fixture() {
    const [admin, buyerSigner, parentFactorySigner, subcontractorSigner, auditorSigner, relayer, outsider, nestedFactorySigner] =
      await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("subcontract-buyer"));
    const parentFactoryId = ethers.keccak256(ethers.toUtf8Bytes("primary-factory"));
    const subcontractorId = ethers.keccak256(ethers.toUtf8Bytes("subcontractor-factory"));
    const nestedFactoryId = ethers.keccak256(ethers.toUtf8Bytes("nested-factory"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("subcontract-auditor"));
    await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(parentFactoryId, parentFactorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(subcontractorId, subcontractorSigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(nestedFactoryId, nestedFactorySigner.address, 2, ethers.ZeroHash);
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

    const Governor = await ethers.getContractFactory("SubcontractGovernor");
    const governor = await Governor.deploy(
      admin.address,
      await registry.getAddress(),
      await credentials.getAddress(),
      await orders.getAddress(),
      await vault.getAddress()
    );
    await governor.waitForDeployment();

    const network = await ethers.provider.getNetwork();
    const orderDomain = {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await orders.getAddress(),
    };
    const subcontractDomain = {
      name: "ThreadProof SubcontractGovernor",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await governor.getAddress(),
    };

    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("subcontract-policy-v1"));
    const complianceType = ethers.keccak256(ethers.toUtf8Bytes("FACTORY_COMPLIANCE_CREDENTIAL"));
    const processCredentialType = ethers.keccak256(ethers.toUtf8Bytes("PROCESS_CREDENTIAL"));
    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-10"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
    await governor.registerPolicy(policyHash, 3, complianceType, processCredentialType);

    return {
      admin,
      buyerSigner,
      parentFactorySigner,
      subcontractorSigner,
      auditorSigner,
      relayer,
      outsider,
      nestedFactorySigner,
      registry,
      credentials,
      orders,
      verifier,
      vault,
      governor,
      orderDomain,
      subcontractDomain,
      buyerId,
      parentFactoryId,
      subcontractorId,
      nestedFactoryId,
      auditorId,
      policyHash,
      complianceType,
      processCredentialType,
      periodId,
      processId,
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function registerOrder(
    f: Fixture,
    factoryOrganizationId: string,
    label: string,
    orderCommitment: bigint,
    policyHash = f.policyHash
  ) {
    const orderId = ethers.keccak256(ethers.toUtf8Bytes(label));
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId,
      buyerOrganizationId: f.buyerId,
      primaryFactoryOrganizationId: factoryOrganizationId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment,
      policyHash,
      nonce: await f.orders.nonces(f.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.orderDomain, ORDER_TYPES, authorization);
    await f.orders.connect(f.relayer).submitOrderVersion(authorization, signature);
    return orderId;
  }

  async function amendOrder(
    f: Fixture,
    orderId: string,
    factoryOrganizationId: string,
    orderCommitment: bigint,
    policyHash = f.policyHash
  ) {
    const state = await f.orders.getOrder(orderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId,
      buyerOrganizationId: f.buyerId,
      primaryFactoryOrganizationId: factoryOrganizationId,
      version: Number(state.currentVersion) + 1,
      previousVersionHash: state.currentVersionHash,
      orderCommitment,
      policyHash,
      nonce: await f.orders.nonces(f.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.orderDomain, ORDER_TYPES, authorization);
    await f.orders.connect(f.relayer).submitOrderVersion(authorization, signature);
  }

  async function cancelOrder(f: Fixture, orderId: string) {
    const state = await f.orders.getOrder(orderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId,
      buyerOrganizationId: f.buyerId,
      expectedVersion: Number(state.currentVersion),
      nonce: await f.orders.nonces(f.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.orderDomain, CANCEL_TYPES, authorization);
    await f.orders.connect(f.relayer).cancelOrder(authorization, signature);
  }

  async function issueSubcontractCredentials(f: Fixture, factoryId = f.subcontractorId, processId = f.processId) {
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const complianceCredentialId = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "string"], [factoryId, "compliance"])
    );
    const processCredentialId = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "bytes32", "string"], [factoryId, processId, "process"])
    );
    await f.credentials.connect(f.auditorSigner).issueCredential(
      complianceCredentialId,
      factoryId,
      f.complianceType,
      ethers.keccak256(ethers.toUtf8Bytes("compliance-body")),
      await f.governor.complianceCredentialScopeHash(factoryId, f.policyHash),
      now - 60n,
      now + 86_400n
    );
    await f.credentials.connect(f.auditorSigner).issueCredential(
      processCredentialId,
      factoryId,
      f.processCredentialType,
      ethers.keccak256(ethers.toUtf8Bytes("process-body")),
      await f.governor.processCredentialScopeHash(factoryId, processId, f.policyHash),
      now - 60n,
      now + 86_400n
    );
    return { complianceCredentialId, processCredentialId };
  }

  async function allocateCapacity(
    f: Fixture,
    factoryId: string,
    factorySigner: Fixture["subcontractorSigner"],
    orderId: string,
    orderCommitment: bigint,
    suffix: string,
    periodId = f.periodId,
    processId = f.processId,
    policyHash = f.policyHash
  ) {
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const initialCommitment = BigInt(ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-initial`))) % 1_000_000n) + 10_000n;
    const newCommitment = initialCommitment + 1n;
    const nullifier = BigInt(ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-nullifier`))) % 1_000_000n) + 2_000_000n;
    const capacityCredentialId = ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-capacity-credential`));
    const scope = await f.vault.capacityCredentialScopeHash(factoryId, periodId, processId, policyHash, initialCommitment);
    await f.credentials.connect(f.auditorSigner).issueCredential(
      capacityCredentialId,
      factoryId,
      await f.vault.CAPACITY_CREDENTIAL_TYPE(),
      ethers.keccak256(ethers.toUtf8Bytes(`${suffix}-capacity-body`)),
      scope,
      now - 60n,
      now + 86_400n
    );
    await f.vault.connect(f.auditorSigner).certifyCapacity(
      factoryId,
      periodId,
      processId,
      initialCommitment,
      capacityCredentialId,
      policyHash,
      1
    );
    await f.vault.connect(factorySigner).spendCapacity({
      factoryOrganizationId: factoryId,
      periodId,
      processId,
      orderId,
      policyHash,
      oldCapacityCommitment: initialCommitment,
      newCapacityCommitment: newCommitment,
      orderCommitment,
      nullifier,
      circuitVersion: 1,
    }, ZERO_A, ZERO_B, ZERO_C);
    const stateKey = await f.vault.capacityStateKey(factoryId, periodId, processId);
    return f.vault.capacityAllocationId(stateKey, orderId, nullifier);
  }

  async function directContext(f: Fixture) {
    const parentOrderId = await registerOrder(f, f.parentFactoryId, "parent-order", 11_001n);
    const childOrderId = await registerOrder(f, f.subcontractorId, "child-order", 22_002n);
    const credentials = await issueSubcontractCredentials(f);
    const capacityAllocationId = await allocateCapacity(
      f,
      f.subcontractorId,
      f.subcontractorSigner,
      childOrderId,
      22_002n,
      "child"
    );
    return { parentOrderId, childOrderId, ...credentials, capacityAllocationId };
  }

  async function signedAuthorization(
    f: Fixture,
    input: {
      parentOrderId: string;
      childOrderId: string;
      parentFactoryOrganizationId: string;
      subcontractorOrganizationId: string;
      complianceCredentialId: string;
      processCredentialId: string;
      capacityAllocationId: string;
      signer: Fixture["parentFactorySigner"];
      sequence?: number;
      nonce?: bigint;
      periodId?: string;
      processId?: string;
      policyHash?: string;
      parentVersionHash?: string;
      childVersionHash?: string;
    }
  ) {
    const parent = await f.orders.getOrder(input.parentOrderId);
    const child = await f.orders.getOrder(input.childOrderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      parentOrderId: input.parentOrderId,
      childOrderId: input.childOrderId,
      parentFactoryOrganizationId: input.parentFactoryOrganizationId,
      subcontractorOrganizationId: input.subcontractorOrganizationId,
      periodId: input.periodId ?? f.periodId,
      processId: input.processId ?? f.processId,
      policyHash: input.policyHash ?? f.policyHash,
      parentVersionHash: input.parentVersionHash ?? parent.currentVersionHash,
      childVersionHash: input.childVersionHash ?? child.currentVersionHash,
      complianceCredentialId: input.complianceCredentialId,
      processCredentialId: input.processCredentialId,
      capacityAllocationId: input.capacityAllocationId,
      sequence: input.sequence ?? 1,
      nonce: input.nonce ?? await f.governor.nonces(input.parentFactoryOrganizationId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await input.signer.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, authorization);
    return { authorization, signature };
  }

  async function authorizeDirect(f: Fixture) {
    const context = await directContext(f);
    const signed = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });
    await f.governor.connect(f.relayer).authorizeSubcontract(signed.authorization, signed.signature);
    return { ...context, ...signed };
  }

  it("anchors a parent-signed subcontract to the buyer-signed child order and canonical PoFC allocation", async function () {
    const f = await fixture();
    const context = await directContext(f);
    const signed = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });

    await expect(f.governor.connect(f.relayer).authorizeSubcontract(signed.authorization, signed.signature))
      .to.emit(f.governor, "SubcontractAuthorized");

    const record = await f.governor.getSubcontractAuthorization(context.childOrderId);
    const allocation = await f.vault.getCapacityAllocation(context.capacityAllocationId);
    expect(record.parentOrderId).to.equal(context.parentOrderId);
    expect(record.capacityAllocationId).to.equal(context.capacityAllocationId);
    expect(record.capacityNullifier).to.equal(allocation.nullifier);
    expect(record.depth).to.equal(1);
    expect(await f.governor.isSubcontractAuthorizationActive(context.childOrderId)).to.equal(true);
  });

  it("rejects an unknown parent order", async function () {
    const f = await fixture();
    const context = await directContext(f);
    const unknownParent = ethers.keccak256(ethers.toUtf8Bytes("unknown-parent"));
    const child = await f.orders.getOrder(context.childOrderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      parentOrderId: unknownParent,
      childOrderId: context.childOrderId,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      periodId: f.periodId,
      processId: f.processId,
      policyHash: f.policyHash,
      parentVersionHash: ethers.ZeroHash,
      childVersionHash: child.currentVersionHash,
      complianceCredentialId: context.complianceCredentialId,
      processCredentialId: context.processCredentialId,
      capacityAllocationId: context.capacityAllocationId,
      sequence: 1,
      nonce: 0n,
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.parentFactorySigner.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, authorization);
    await expect(f.governor.authorizeSubcontract(authorization, signature))
      .to.be.revertedWithCustomError(f.governor, "UnknownParentOrder")
      .withArgs(unknownParent);
  });

  it("fails closed after a parent amendment and rejects the stale signed parent snapshot", async function () {
    const f = await fixture();
    const context = await authorizeDirect(f);
    await amendOrder(f, context.parentOrderId, f.parentFactoryId, 11_111n);
    expect(await f.governor.isSubcontractAuthorizationActive(context.childOrderId)).to.equal(false);

    await expect(f.governor.authorizeSubcontract(context.authorization, context.signature))
      .to.be.revertedWithCustomError(f.governor, "ParentVersionMismatch");
  });

  it("fails closed when the parent order is cancelled", async function () {
    const f = await fixture();
    const context = await authorizeDirect(f);
    await cancelOrder(f, context.parentOrderId);
    expect(await f.governor.isSubcontractAuthorizationActive(context.childOrderId)).to.equal(false);

    await expect(f.governor.authorizeSubcontract(context.authorization, context.signature))
      .to.be.revertedWithCustomError(f.governor, "InactiveParentOrder")
      .withArgs(context.parentOrderId);
  });

  it("rejects inactive subcontractors even when an earlier capacity proof succeeded", async function () {
    const f = await fixture();
    const context = await directContext(f);
    const signed = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });
    await f.registry.setOrganizationStatus(f.subcontractorId, 2);
    await expect(f.governor.authorizeSubcontract(signed.authorization, signed.signature))
      .to.be.revertedWithCustomError(f.governor, "InactiveFactory")
      .withArgs(f.subcontractorId);
  });

  it("checks the subcontractor factory role independently from OrderRegistry", async function () {
    const [admin, buyerSigner, parentSigner, subSigner, auditorSigner, relayer] = await ethers.getSigners();
    const MutableRegistry = await ethers.getContractFactory("MutableThreadProofRegistry");
    const registry = await MutableRegistry.deploy();
    await registry.waitForDeployment();
    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("mutable-buyer"));
    const parentId = ethers.keccak256(ethers.toUtf8Bytes("mutable-parent"));
    const subId = ethers.keccak256(ethers.toUtf8Bytes("mutable-sub"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("mutable-auditor"));
    await registry.setOrganization(buyerId, buyerSigner.address, 1, true);
    await registry.setOrganization(parentId, parentSigner.address, 2, true);
    await registry.setOrganization(subId, subSigner.address, 2, true);
    await registry.setOrganization(auditorId, auditorSigner.address, 3, true);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);
    const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
    const orders = await OrderRegistry.deploy(await registry.getAddress());
    await orders.waitForDeployment();
    const Verifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    const Vault = await ethers.getContractFactory("CapacityVault");
    const vault = await Vault.deploy(admin.address, await credentials.getAddress(), await orders.getAddress(), await registry.getAddress());
    await vault.waitForDeployment();
    await vault.registerVerifier(1, await verifier.getAddress());
    await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorSigner.address);
    const Governor = await ethers.getContractFactory("SubcontractGovernor");
    const governor = await Governor.deploy(admin.address, await registry.getAddress(), await credentials.getAddress(), await orders.getAddress(), await vault.getAddress());
    await governor.waitForDeployment();

    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("mutable-policy"));
    const complianceType = ethers.keccak256(ethers.toUtf8Bytes("FACTORY_COMPLIANCE_CREDENTIAL"));
    const processType = ethers.keccak256(ethers.toUtf8Bytes("PROCESS_CREDENTIAL"));
    await governor.registerPolicy(policyHash, 2, complianceType, processType);
    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-10"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
    const network = await ethers.provider.getNetwork();
    const orderDomain = { name: "ThreadProof OrderRegistry", version: "1", chainId: network.chainId, verifyingContract: await orders.getAddress() };

    async function submit(orderId: string, factoryId: string, commitment: bigint) {
      const latest = await ethers.provider.getBlock("latest");
      const auth = { orderId, buyerOrganizationId: buyerId, primaryFactoryOrganizationId: factoryId, version: 1, previousVersionHash: ethers.ZeroHash, orderCommitment: commitment, policyHash, nonce: await orders.nonces(buyerId), deadline: BigInt(latest!.timestamp) + 3600n };
      await orders.connect(relayer).submitOrderVersion(auth, await buyerSigner.signTypedData(orderDomain, ORDER_TYPES, auth));
    }
    const parentOrderId = ethers.keccak256(ethers.toUtf8Bytes("mutable-parent-order"));
    const childOrderId = ethers.keccak256(ethers.toUtf8Bytes("mutable-child-order"));
    await submit(parentOrderId, parentId, 111n);
    await submit(childOrderId, subId, 222n);

    // Role drift after a valid buyer-signed order must still be rejected by the governor itself.
    await registry.setRole(subId, 1);
    const parent = await orders.getOrder(parentOrderId);
    const child = await orders.getOrder(childOrderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = { parentOrderId, childOrderId, parentFactoryOrganizationId: parentId, subcontractorOrganizationId: subId, periodId, processId, policyHash, parentVersionHash: parent.currentVersionHash, childVersionHash: child.currentVersionHash, complianceCredentialId: ethers.ZeroHash, processCredentialId: ethers.ZeroHash, capacityAllocationId: ethers.ZeroHash, sequence: 1, nonce: 0n, deadline: BigInt(latest!.timestamp) + 3600n };
    const domain = { name: "ThreadProof SubcontractGovernor", version: "1", chainId: network.chainId, verifyingContract: await governor.getAddress() };
    const signature = await parentSigner.signTypedData(domain, SUBCONTRACT_TYPES, authorization);
    await expect(governor.authorizeSubcontract(authorization, signature))
      .to.be.revertedWithCustomError(governor, "InvalidFactoryRole")
      .withArgs(subId);
  });

  it("requires both policy-scoped compliance and process credentials and reacts to revocation", async function () {
    const f = await fixture();
    const context = await directContext(f);
    await f.credentials.connect(f.auditorSigner).revokeCredential(context.processCredentialId);
    const signed = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });
    await expect(f.governor.authorizeSubcontract(signed.authorization, signed.signature))
      .to.be.revertedWithCustomError(f.governor, "InvalidProcessCredential")
      .withArgs(context.processCredentialId);
  });

  it("rejects a missing or mismatched on-chain capacity allocation reference", async function () {
    const f = await fixture();
    const context = await directContext(f);
    const badAllocation = ethers.keccak256(ethers.toUtf8Bytes("not-a-capacity-allocation"));
    const signed = await signedAuthorization(f, {
      ...context,
      capacityAllocationId: badAllocation,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });
    await expect(f.governor.authorizeSubcontract(signed.authorization, signed.signature))
      .to.be.revertedWithCustomError(f.governor, "InvalidCapacityAllocation")
      .withArgs(badAllocation);
  });

  it("enforces maximum depth before a nested factory can be authorized", async function () {
    const f = await fixture();
    const maxOnePolicy = ethers.keccak256(ethers.toUtf8Bytes("max-depth-one-policy"));
    await f.governor.registerPolicy(maxOnePolicy, 1, f.complianceType, f.processCredentialType);

    const parentOrderId = await registerOrder(f, f.parentFactoryId, "depth-root", 31_001n, maxOnePolicy);
    const childOrderId = await registerOrder(f, f.subcontractorId, "depth-child", 32_002n, maxOnePolicy);
    const nestedOrderId = await registerOrder(f, f.nestedFactoryId, "depth-nested", 33_003n, maxOnePolicy);

    // Use policy-scoped credentials/capacity for the first level.
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const complianceId = ethers.keccak256(ethers.toUtf8Bytes("depth-compliance"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("depth-process"));
    await f.credentials.connect(f.auditorSigner).issueCredential(complianceId, f.subcontractorId, f.complianceType, ethers.ZeroHash, await f.governor.complianceCredentialScopeHash(f.subcontractorId, maxOnePolicy), now - 60n, now + 86_400n);
    await f.credentials.connect(f.auditorSigner).issueCredential(processId, f.subcontractorId, f.processCredentialType, ethers.ZeroHash, await f.governor.processCredentialScopeHash(f.subcontractorId, f.processId, maxOnePolicy), now - 60n, now + 86_400n);
    const allocationId = await allocateCapacity(f, f.subcontractorId, f.subcontractorSigner, childOrderId, 32_002n, "depth-child", f.periodId, f.processId, maxOnePolicy);

    const parent = await f.orders.getOrder(parentOrderId);
    const child = await f.orders.getOrder(childOrderId);
    const direct = { parentOrderId, childOrderId, parentFactoryOrganizationId: f.parentFactoryId, subcontractorOrganizationId: f.subcontractorId, periodId: f.periodId, processId: f.processId, policyHash: maxOnePolicy, parentVersionHash: parent.currentVersionHash, childVersionHash: child.currentVersionHash, complianceCredentialId: complianceId, processCredentialId: processId, capacityAllocationId: allocationId, sequence: 1, nonce: 0n, deadline: now + 3_600n };
    await f.governor.authorizeSubcontract(direct, await f.parentFactorySigner.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, direct));

    const nested = await f.orders.getOrder(nestedOrderId);
    const nestedAuthorization = { parentOrderId: childOrderId, childOrderId: nestedOrderId, parentFactoryOrganizationId: f.subcontractorId, subcontractorOrganizationId: f.nestedFactoryId, periodId: f.periodId, processId: f.processId, policyHash: maxOnePolicy, parentVersionHash: child.currentVersionHash, childVersionHash: nested.currentVersionHash, complianceCredentialId: ethers.ZeroHash, processCredentialId: ethers.ZeroHash, capacityAllocationId: ethers.ZeroHash, sequence: 1, nonce: 0n, deadline: now + 3_600n };
    const signature = await f.subcontractorSigner.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, nestedAuthorization);
    await expect(f.governor.authorizeSubcontract(nestedAuthorization, signature))
      .to.be.revertedWithCustomError(f.governor, "MaxDepthExceeded")
      .withArgs(1, 2);
  });

  it("rejects cycles and re-parenting of an existing child authorization", async function () {
    const f = await fixture();
    const context = await authorizeDirect(f);

    const rootState = await f.orders.getOrder(context.parentOrderId);
    const childState = await f.orders.getOrder(context.childOrderId);
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const cycle = { parentOrderId: context.childOrderId, childOrderId: context.parentOrderId, parentFactoryOrganizationId: f.subcontractorId, subcontractorOrganizationId: f.parentFactoryId, periodId: f.periodId, processId: f.processId, policyHash: f.policyHash, parentVersionHash: childState.currentVersionHash, childVersionHash: rootState.currentVersionHash, complianceCredentialId: ethers.ZeroHash, processCredentialId: ethers.ZeroHash, capacityAllocationId: ethers.ZeroHash, sequence: 1, nonce: 0n, deadline: now + 3_600n };
    await expect(f.governor.authorizeSubcontract(cycle, await f.subcontractorSigner.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, cycle)))
      .to.be.revertedWithCustomError(f.governor, "SubcontractCycle");

    const otherParentOrderId = await registerOrder(f, f.nestedFactoryId, "other-parent", 44_004n);
    const otherParent = await f.orders.getOrder(otherParentOrderId);
    const reparent = { ...context.authorization, parentOrderId: otherParentOrderId, parentFactoryOrganizationId: f.nestedFactoryId, parentVersionHash: otherParent.currentVersionHash, sequence: 2, nonce: 0n, deadline: now + 3_600n };
    await expect(f.governor.authorizeSubcontract(reparent, await f.nestedFactorySigner.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, reparent)))
      .to.be.revertedWithCustomError(f.governor, "ExistingParentMismatch")
      .withArgs(context.childOrderId, context.parentOrderId, otherParentOrderId);
  });

  it("requires the parent factory signature and rejects replay", async function () {
    const f = await fixture();
    const context = await directContext(f);
    const wrong = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.outsider,
    });
    await expect(f.governor.authorizeSubcontract(wrong.authorization, wrong.signature))
      .to.be.revertedWithCustomError(f.governor, "UnauthorizedParentFactorySigner");

    const valid = await signedAuthorization(f, {
      ...context,
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorOrganizationId: f.subcontractorId,
      signer: f.parentFactorySigner,
    });
    await f.governor.authorizeSubcontract(valid.authorization, valid.signature);
    await expect(f.governor.authorizeSubcontract(valid.authorization, valid.signature))
      .to.be.revertedWithCustomError(f.governor, "InvalidSequence")
      .withArgs(2, 1);
  });
});
