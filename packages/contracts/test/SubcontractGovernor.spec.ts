import { expect } from "chai";
import { ethers } from "hardhat";

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
    { name: "parentOrderCommitment", type: "uint256" },
    { name: "parentAuthorizationId", type: "bytes32" },
    { name: "childAuthorizationId", type: "bytes32" },
    { name: "parentFactoryOrganizationId", type: "bytes32" },
    { name: "subcontractorFactoryOrganizationId", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "capacityPeriodId", type: "bytes32" },
    { name: "capacityProcessId", type: "bytes32" },
    { name: "capacityCommitment", type: "uint256" },
    { name: "complianceCredentialId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

describe("SubcontractGovernor", function () {
  async function fixture() {
    const [admin, buyer, parentFactory, subcontractor, tier2Factory, auditor, outsider] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("sub-buyer"));
    const parentFactoryId = ethers.keccak256(ethers.toUtf8Bytes("parent-factory"));
    const subcontractorId = ethers.keccak256(ethers.toUtf8Bytes("subcontractor"));
    const tier2FactoryId = ethers.keccak256(ethers.toUtf8Bytes("tier-two"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("sub-auditor"));
    const wrongRoleId = ethers.keccak256(ethers.toUtf8Bytes("wrong-role"));
    await registry.registerOrganization(buyerId, buyer.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(parentFactoryId, parentFactory.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(subcontractorId, subcontractor.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(tier2FactoryId, tier2Factory.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(auditorId, auditor.address, 3, ethers.ZeroHash);
    await registry.registerOrganization(wrongRoleId, outsider.address, 1, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditor.address);

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
    await vault.grantRole(await vault.CERTIFIER_ROLE(), auditor.address);

    const Governor = await ethers.getContractFactory("SubcontractGovernor");
    const governor = await Governor.deploy(admin.address, await orders.getAddress(), await registry.getAddress(), await credentials.getAddress(), await vault.getAddress());
    await governor.waitForDeployment();

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const orderDomain = { name: "ThreadProof OrderRegistry", version: "1", chainId, verifyingContract: await orders.getAddress() };
    const subcontractDomain = { name: "ThreadProof SubcontractGovernor", version: "1", chainId, verifyingContract: await governor.getAddress() };
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("sub-policy-v1"));
    const complianceType = ethers.keccak256(ethers.toUtf8Bytes("PROCESS_COMPLIANCE"));
    await governor.configurePolicyRequirement(policyHash, 2, complianceType);

    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const parentOrderId = ethers.keccak256(ethers.toUtf8Bytes("parent-order"));
    const parentOrderCommitment = 1111n;
    const orderAuth = {
      orderId: parentOrderId,
      buyerOrganizationId: buyerId,
      primaryFactoryOrganizationId: parentFactoryId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment: parentOrderCommitment,
      policyHash,
      nonce: 0n,
      deadline: now + 3600n,
    };
    await orders.submitOrderVersion(orderAuth, await buyer.signTypedData(orderDomain, ORDER_TYPES, orderAuth));

    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-Q4"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));

    async function certifyFactory(factoryId: string, label: string, commitment: bigint) {
      const capacityCredentialId = ethers.keccak256(ethers.toUtf8Bytes(`${label}-capacity`));
      const capacityType = await vault.CAPACITY_CREDENTIAL_TYPE();
      const capacityScope = await vault.capacityCredentialScopeHash(factoryId, periodId, processId, policyHash, commitment);
      await credentials.connect(auditor).issueCredential(capacityCredentialId, factoryId, capacityType, ethers.keccak256(ethers.toUtf8Bytes(`${label}-capacity-body`)), capacityScope, now - 60n, now + 86400n);
      await vault.connect(auditor).certifyCapacity(factoryId, periodId, processId, commitment, capacityCredentialId, policyHash, 1);

      const complianceId = ethers.keccak256(ethers.toUtf8Bytes(`${label}-compliance`));
      const complianceScope = await governor.complianceCredentialScopeHash(factoryId, policyHash, complianceType);
      await credentials.connect(auditor).issueCredential(complianceId, factoryId, complianceType, ethers.keccak256(ethers.toUtf8Bytes(`${label}-compliance-body`)), complianceScope, now - 60n, now + 86400n);
      return { capacityCredentialId, complianceId };
    }

    const subCredentials = await certifyFactory(subcontractorId, "sub", 2222n);
    const tier2Credentials = await certifyFactory(tier2FactoryId, "tier2", 3333n);

    return { admin, buyer, parentFactory, subcontractor, tier2Factory, auditor, outsider, registry, credentials, orders, vault, governor, orderDomain, subcontractDomain, buyerId, parentFactoryId, subcontractorId, tier2FactoryId, wrongRoleId, policyHash, complianceType, now, parentOrderId, parentOrderCommitment, periodId, processId, subCredentials, tier2Credentials };
  }

  function request(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
    return {
      parentOrderId: f.parentOrderId,
      parentOrderCommitment: f.parentOrderCommitment,
      parentAuthorizationId: ethers.ZeroHash,
      childAuthorizationId: ethers.keccak256(ethers.toUtf8Bytes("child-one")),
      parentFactoryOrganizationId: f.parentFactoryId,
      subcontractorFactoryOrganizationId: f.subcontractorId,
      policyHash: f.policyHash,
      capacityPeriodId: f.periodId,
      capacityProcessId: f.processId,
      capacityCommitment: 2222n,
      complianceCredentialId: f.subCredentials.complianceId,
      nonce: 0n,
      deadline: f.now + 3600n,
      ...overrides,
    };
  }

  async function sign(f: Awaited<ReturnType<typeof fixture>>, req: ReturnType<typeof request>, signer = f.parentFactory) {
    return signer.signTypedData(f.subcontractDomain, SUBCONTRACT_TYPES, req);
  }

  it("records an immutable root subcontract using only IDs, commitments and on-chain references", async function () {
    const f = await fixture();
    const req = request(f);
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.emit(f.governor, "SubcontractAuthorized");
    const record = await f.governor.getAuthorization(req.childAuthorizationId);
    expect(record.rootOrderId).to.equal(f.parentOrderId);
    expect(record.subcontractorFactoryOrganizationId).to.equal(f.subcontractorId);
    expect(record.depth).to.equal(1);
    expect(record.capacityCommitment).to.equal(2222n);
  });

  it("allows a second tier only when the first-tier subcontractor signs and depth remains within policy", async function () {
    const f = await fixture();
    const first = request(f);
    await f.governor.authorizeSubcontract(first, await sign(f, first));
    const second = request(f, {
      parentAuthorizationId: first.childAuthorizationId,
      childAuthorizationId: ethers.keccak256(ethers.toUtf8Bytes("child-two")),
      parentFactoryOrganizationId: f.subcontractorId,
      subcontractorFactoryOrganizationId: f.tier2FactoryId,
      capacityCommitment: 3333n,
      complianceCredentialId: f.tier2Credentials.complianceId,
      nonce: 0n,
    });
    await f.governor.authorizeSubcontract(second, await sign(f, second, f.subcontractor));
    expect((await f.governor.getAuthorization(second.childAuthorizationId)).depth).to.equal(2);
  });

  it("rejects an amended parent order because the signed root commitment is no longer current", async function () {
    const f = await fixture();
    const state = await f.orders.getOrder(f.parentOrderId);
    const auth = {
      orderId: f.parentOrderId,
      buyerOrganizationId: f.buyerId,
      primaryFactoryOrganizationId: f.parentFactoryId,
      version: 2,
      previousVersionHash: state.currentVersionHash,
      orderCommitment: f.parentOrderCommitment + 1n,
      policyHash: f.policyHash,
      nonce: 1n,
      deadline: f.now + 3600n,
    };
    await f.orders.submitOrderVersion(auth, await f.buyer.signTypedData(f.orderDomain, ORDER_TYPES, auth));
    const req = request(f);
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "InvalidParentOrderAuthorization").withArgs(f.parentOrderId);
  });

  it("rejects a cancelled parent order", async function () {
    const f = await fixture();
    const cancel = { orderId: f.parentOrderId, buyerOrganizationId: f.buyerId, expectedVersion: 1, nonce: 1n, deadline: f.now + 3600n };
    await f.orders.cancelOrder(cancel, await f.buyer.signTypedData(f.orderDomain, CANCEL_TYPES, cancel));
    const req = request(f);
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "InvalidParentOrderAuthorization");
  });

  it("rejects inactive and wrong-role subcontractors", async function () {
    const f = await fixture();
    await f.registry.setOrganizationStatus(f.subcontractorId, 2);
    const inactive = request(f);
    await expect(f.governor.authorizeSubcontract(inactive, await sign(f, inactive))).to.be.revertedWithCustomError(f.governor, "InactiveSubcontractor");

    const wrongRole = request(f, { subcontractorFactoryOrganizationId: f.wrongRoleId });
    await expect(f.governor.authorizeSubcontract(wrongRole, await sign(f, wrongRole))).to.be.revertedWithCustomError(f.governor, "InvalidSubcontractorRole");
  });

  it("rejects a revoked compliance credential", async function () {
    const f = await fixture();
    await f.credentials.connect(f.auditor).revokeCredential(f.subCredentials.complianceId);
    const req = request(f);
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "InvalidComplianceCredential").withArgs(f.subCredentials.complianceId);
  });

  it("rejects a stale or invented capacity commitment rather than trusting an indexed database row", async function () {
    const f = await fixture();
    const req = request(f, { capacityCommitment: 9999n });
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "CapacityCommitmentMismatch").withArgs(2222n, 9999n);
  });

  it("rejects re-parenting an already authorized child", async function () {
    const f = await fixture();
    const req = request(f);
    await f.governor.authorizeSubcontract(req, await sign(f, req));
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "ChildAlreadyAuthorized").withArgs(req.childAuthorizationId);
  });

  it("rejects cycle-shaped self references before writing authorization state", async function () {
    const f = await fixture();
    const child = f.parentOrderId;
    const req = request(f, { childAuthorizationId: child });
    await expect(f.governor.authorizeSubcontract(req, await sign(f, req))).to.be.revertedWithCustomError(f.governor, "CycleDetected").withArgs(child);
  });

  it("rejects depth overflow and signatures from accounts outside the parent factory", async function () {
    const f = await fixture();
    const first = request(f);
    await f.governor.authorizeSubcontract(first, await sign(f, first));
    const second = request(f, { parentAuthorizationId: first.childAuthorizationId, childAuthorizationId: ethers.keccak256(ethers.toUtf8Bytes("depth-two")), parentFactoryOrganizationId: f.subcontractorId, subcontractorFactoryOrganizationId: f.tier2FactoryId, capacityCommitment: 3333n, complianceCredentialId: f.tier2Credentials.complianceId, nonce: 0n });
    await f.governor.authorizeSubcontract(second, await sign(f, second, f.subcontractor));

    const third = request(f, { parentAuthorizationId: second.childAuthorizationId, childAuthorizationId: ethers.keccak256(ethers.toUtf8Bytes("depth-three")), parentFactoryOrganizationId: f.tier2FactoryId, subcontractorFactoryOrganizationId: f.subcontractorId, capacityCommitment: 2222n, complianceCredentialId: f.subCredentials.complianceId, nonce: 0n });
    await expect(f.governor.authorizeSubcontract(third, await sign(f, third, f.tier2Factory))).to.be.revertedWithCustomError(f.governor, "DepthExceeded").withArgs(3, 2);

    const badSig = request(f, { childAuthorizationId: ethers.keccak256(ethers.toUtf8Bytes("bad-signer")), nonce: 1n });
    await expect(f.governor.authorizeSubcontract(badSig, await sign(f, badSig, f.outsider))).to.be.revertedWithCustomError(f.governor, "UnauthorizedParentFactorySigner");
  });
});
