import { expect } from "chai";
import { ethers } from "hardhat";

describe("OrderRegistry", function () {
  async function fixture() {
    const [admin, buyerSigner, factorySigner, otherBuyerSigner, otherFactorySigner, relayer] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("buyer-one"));
    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha"));
    const otherBuyerId = ethers.keccak256(ethers.toUtf8Bytes("buyer-two"));
    const otherFactoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-beta"));

    await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(otherBuyerId, otherBuyerSigner.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(otherFactoryId, otherFactorySigner.address, 2, ethers.ZeroHash);

    const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
    const orders = await OrderRegistry.deploy(await registry.getAddress());
    await orders.waitForDeployment();

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await orders.getAddress(),
    };

    const orderTypes = {
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

    const cancelTypes = {
      CancelOrder: [
        { name: "orderId", type: "bytes32" },
        { name: "buyerOrganizationId", type: "bytes32" },
        { name: "expectedVersion", type: "uint32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    };

    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const orderId = ethers.keccak256(ethers.toUtf8Bytes("buyer-one:po-2026-001"));
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("policy-v1"));

    return {
      admin,
      buyerSigner,
      factorySigner,
      otherBuyerSigner,
      otherFactorySigner,
      relayer,
      registry,
      orders,
      buyerId,
      factoryId,
      otherBuyerId,
      otherFactoryId,
      domain,
      orderTypes,
      cancelTypes,
      now,
      orderId,
      policyHash,
    };
  }

  function versionAuthorization(
    f: Awaited<ReturnType<typeof fixture>>,
    overrides: Partial<{
      orderId: string;
      buyerOrganizationId: string;
      primaryFactoryOrganizationId: string;
      version: number;
      previousVersionHash: string;
      orderCommitment: bigint;
      policyHash: string;
      nonce: bigint;
      deadline: bigint;
    }> = {}
  ) {
    return {
      orderId: overrides.orderId ?? f.orderId,
      buyerOrganizationId: overrides.buyerOrganizationId ?? f.buyerId,
      primaryFactoryOrganizationId: overrides.primaryFactoryOrganizationId ?? f.factoryId,
      version: overrides.version ?? 1,
      previousVersionHash: overrides.previousVersionHash ?? ethers.ZeroHash,
      orderCommitment: overrides.orderCommitment ?? 11_001n,
      policyHash: overrides.policyHash ?? f.policyHash,
      nonce: overrides.nonce ?? 0n,
      deadline: overrides.deadline ?? f.now + 3_600n,
    };
  }

  it("records version 1 from a buyer EIP-712 signature even when a relayer submits it", async function () {
    const f = await fixture();
    const authorization = versionAuthorization(f);
    const signature = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, authorization);

    await expect(f.orders.connect(f.relayer).submitOrderVersion(authorization, signature))
      .to.emit(f.orders, "OrderVersionRecorded");

    const state = await f.orders.getOrder(f.orderId);
    expect(state.buyerOrganizationId).to.equal(f.buyerId);
    expect(state.primaryFactoryOrganizationId).to.equal(f.factoryId);
    expect(state.currentVersion).to.equal(1);
    expect(state.currentOrderCommitment).to.equal(11_001n);
    expect(state.currentPolicyHash).to.equal(f.policyHash);
    expect(state.status).to.equal(1);
    expect(await f.orders.nonces(f.buyerId)).to.equal(1n);
    expect(
      await f.orders.isCurrentOrderAuthorization(f.orderId, f.factoryId, 11_001n, f.policyHash)
    ).to.equal(true);
  });

  it("appends an immutable next version linked to the previous version hash", async function () {
    const f = await fixture();
    const v1 = versionAuthorization(f);
    const sig1 = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, v1);
    await f.orders.connect(f.relayer).submitOrderVersion(v1, sig1);

    const afterV1 = await f.orders.getOrder(f.orderId);
    const v1Record = await f.orders.getOrderVersion(f.orderId, 1);
    const v2 = versionAuthorization(f, {
      version: 2,
      previousVersionHash: afterV1.currentVersionHash,
      orderCommitment: 22_002n,
      nonce: 1n,
    });
    const sig2 = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, v2);
    await f.orders.connect(f.relayer).submitOrderVersion(v2, sig2);

    const state = await f.orders.getOrder(f.orderId);
    expect(state.currentVersion).to.equal(2);
    expect(state.currentOrderCommitment).to.equal(22_002n);
    expect(await f.orders.nonces(f.buyerId)).to.equal(2n);

    const storedV1 = await f.orders.getOrderVersion(f.orderId, 1);
    const storedV2 = await f.orders.getOrderVersion(f.orderId, 2);
    expect(storedV1.versionHash).to.equal(v1Record.versionHash);
    expect(storedV1.orderCommitment).to.equal(11_001n);
    expect(storedV2.previousVersionHash).to.equal(v1Record.versionHash);
    expect(storedV2.orderCommitment).to.equal(22_002n);

    expect(
      await f.orders.isCurrentOrderAuthorization(f.orderId, f.factoryId, 11_001n, f.policyHash)
    ).to.equal(false);
    expect(
      await f.orders.isCurrentOrderAuthorization(f.orderId, f.factoryId, 22_002n, f.policyHash)
    ).to.equal(true);
  });

  it("rejects replay of an already consumed buyer nonce", async function () {
    const f = await fixture();
    const authorization = versionAuthorization(f);
    const signature = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, authorization);
    await f.orders.submitOrderVersion(authorization, signature);

    await expect(f.orders.submitOrderVersion(authorization, signature))
      .to.be.revertedWithCustomError(f.orders, "InvalidNonce")
      .withArgs(1n, 0n);
  });

  it("rejects a signature from an account outside the declared buyer organization", async function () {
    const f = await fixture();
    const authorization = versionAuthorization(f);
    const signature = await f.otherBuyerSigner.signTypedData(f.domain, f.orderTypes, authorization);

    await expect(f.orders.connect(f.relayer).submitOrderVersion(authorization, signature))
      .to.be.revertedWithCustomError(f.orders, "UnauthorizedBuyerSigner")
      .withArgs(f.buyerId, f.otherBuyerSigner.address);
  });

  it("rejects an amendment that is not linked to the current version hash", async function () {
    const f = await fixture();
    const v1 = versionAuthorization(f);
    await f.orders.submitOrderVersion(
      v1,
      await f.buyerSigner.signTypedData(f.domain, f.orderTypes, v1)
    );

    const badV2 = versionAuthorization(f, {
      version: 2,
      previousVersionHash: ethers.keccak256(ethers.toUtf8Bytes("stale-version")),
      orderCommitment: 22_002n,
      nonce: 1n,
    });
    const signature = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, badV2);
    const state = await f.orders.getOrder(f.orderId);

    await expect(f.orders.submitOrderVersion(badV2, signature))
      .to.be.revertedWithCustomError(f.orders, "PreviousVersionHashMismatch")
      .withArgs(state.currentVersionHash, badV2.previousVersionHash);
  });

  it("rejects an order whose declared buyer/factory organization roles are wrong", async function () {
    const f = await fixture();
    const authorization = versionAuthorization(f, {
      buyerOrganizationId: f.factoryId,
      primaryFactoryOrganizationId: f.otherFactoryId,
    });
    const signature = await f.factorySigner.signTypedData(f.domain, f.orderTypes, authorization);

    await expect(f.orders.submitOrderVersion(authorization, signature))
      .to.be.revertedWithCustomError(f.orders, "InvalidBuyerRole")
      .withArgs(f.factoryId);
  });

  it("cancels only the current version with a fresh buyer nonce and invalidates future authorization", async function () {
    const f = await fixture();
    const v1 = versionAuthorization(f);
    await f.orders.submitOrderVersion(
      v1,
      await f.buyerSigner.signTypedData(f.domain, f.orderTypes, v1)
    );

    const cancellation = {
      orderId: f.orderId,
      buyerOrganizationId: f.buyerId,
      expectedVersion: 1,
      nonce: 1n,
      deadline: f.now + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.domain, f.cancelTypes, cancellation);
    await expect(f.orders.connect(f.relayer).cancelOrder(cancellation, signature))
      .to.emit(f.orders, "OrderCancelled")
      .withArgs(f.orderId, f.buyerId, 1, 1n, f.buyerSigner.address);

    const state = await f.orders.getOrder(f.orderId);
    expect(state.status).to.equal(2);
    expect(await f.orders.nonces(f.buyerId)).to.equal(2n);
    expect(
      await f.orders.isCurrentOrderAuthorization(f.orderId, f.factoryId, 11_001n, f.policyHash)
    ).to.equal(false);
  });

  it("rejects expired signed order authorizations", async function () {
    const f = await fixture();
    const authorization = versionAuthorization(f, { deadline: f.now - 1n });
    const signature = await f.buyerSigner.signTypedData(f.domain, f.orderTypes, authorization);

    await expect(f.orders.submitOrderVersion(authorization, signature))
      .to.be.revertedWithCustomError(f.orders, "SignatureExpired")
      .withArgs(authorization.deadline);
  });
});
