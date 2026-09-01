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

describe("CapacityVault release", function () {
  async function fixture() {
    const [admin, buyerSigner, factorySigner, auditorSigner, attacker, relayer] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("release-buyer"));
    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("release-factory"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("release-auditor"));
    await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);

    const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
    const orders = await OrderRegistry.deploy(await registry.getAddress());
    await orders.waitForDeployment();

    const SpendVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const spendVerifier = await SpendVerifier.deploy();
    await spendVerifier.waitForDeployment();

    const ReleaseVerifier = await ethers.getContractFactory("MockCapacityReleaseVerifier");
    const releaseVerifier = await ReleaseVerifier.deploy();
    await releaseVerifier.waitForDeployment();

    const Vault = await ethers.getContractFactory("CapacityVault");
    const vault = await Vault.deploy(
      admin.address,
      await credentials.getAddress(),
      await orders.getAddress(),
      await registry.getAddress(),
    );
    await vault.waitForDeployment();
    await vault.registerVerifier(1, await spendVerifier.getAddress());
    await vault.registerReleaseVerifier(1, await releaseVerifier.getAddress());
    await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorSigner.address);

    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-10"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("release-policy-v1"));
    const initialCommitment = 1001n;
    const capacityCredentialId = ethers.keccak256(ethers.toUtf8Bytes("release-capacity-credential"));
    const scopeHash = await vault.capacityCredentialScopeHash(
      factoryId,
      periodId,
      processId,
      policyHash,
      initialCommitment,
    );
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    await credentials.connect(auditorSigner).issueCredential(
      capacityCredentialId,
      factoryId,
      await vault.CAPACITY_CREDENTIAL_TYPE(),
      ethers.keccak256(ethers.toUtf8Bytes("release-credential-body")),
      scopeHash,
      now - 60n,
      now + 86_400n,
    );
    await vault.connect(auditorSigner).certifyCapacity(
      factoryId,
      periodId,
      processId,
      initialCommitment,
      capacityCredentialId,
      policyHash,
      1,
    );

    const network = await ethers.provider.getNetwork();
    const orderDomain = {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await orders.getAddress(),
    };

    return {
      admin,
      buyerSigner,
      factorySigner,
      auditorSigner,
      attacker,
      relayer,
      registry,
      credentials,
      orders,
      spendVerifier,
      releaseVerifier,
      vault,
      buyerId,
      factoryId,
      periodId,
      processId,
      policyHash,
      initialCommitment,
      orderDomain,
    };
  }

  async function registerOrder(
    f: Awaited<ReturnType<typeof fixture>>,
    label: string,
    orderCommitment: bigint,
  ) {
    const orderId = ethers.keccak256(ethers.toUtf8Bytes(label));
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId,
      buyerOrganizationId: f.buyerId,
      primaryFactoryOrganizationId: f.factoryId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment,
      policyHash: f.policyHash,
      nonce: await f.orders.nonces(f.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.orderDomain, ORDER_TYPES, authorization);
    await f.orders.connect(f.relayer).submitOrderVersion(authorization, signature);
    return authorization;
  }

  async function amendOrder(
    f: Awaited<ReturnType<typeof fixture>>,
    orderId: string,
    nextCommitment: bigint,
  ) {
    const current = await f.orders.getOrder(orderId);
    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId,
      buyerOrganizationId: f.buyerId,
      primaryFactoryOrganizationId: f.factoryId,
      version: Number(current.currentVersion) + 1,
      previousVersionHash: current.currentVersionHash,
      orderCommitment: nextCommitment,
      policyHash: f.policyHash,
      nonce: await f.orders.nonces(f.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await f.buyerSigner.signTypedData(f.orderDomain, ORDER_TYPES, authorization);
    await f.orders.connect(f.relayer).submitOrderVersion(authorization, signature);
  }

  async function cancelOrder(f: Awaited<ReturnType<typeof fixture>>, orderId: string) {
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

  async function spend(
    f: Awaited<ReturnType<typeof fixture>>,
    label: string,
    oldCommitment: bigint,
    newCommitment: bigint,
    orderCommitment: bigint,
    nullifier: bigint,
  ) {
    const order = await registerOrder(f, label, orderCommitment);
    const request = {
      factoryOrganizationId: f.factoryId,
      periodId: f.periodId,
      processId: f.processId,
      orderId: order.orderId,
      policyHash: f.policyHash,
      oldCapacityCommitment: oldCommitment,
      newCapacityCommitment: newCommitment,
      orderCommitment,
      nullifier,
      circuitVersion: 1,
    };
    await f.vault.connect(f.factorySigner).spendCapacity(request, ZERO_A, ZERO_B, ZERO_C);
    const stateKey = await f.vault.capacityStateKey(f.factoryId, f.periodId, f.processId);
    const allocationId = await f.vault.capacityAllocationId(stateKey, order.orderId, nullifier);
    return { order, request, allocationId };
  }

  function releaseRequest(
    allocationId: string,
    oldCapacityCommitment = 2002n,
    newCapacityCommitment = 1001n,
    releaseNullifier = 8008n,
  ) {
    return {
      allocationId,
      oldCapacityCommitment,
      newCapacityCommitment,
      releaseNullifier,
      releaseCircuitVersion: 1,
    };
  }

  it("keeps spend and release verifier provenance in separate namespaces", async function () {
    const f = await fixture();
    const spend = await f.vault.getVerifierProvenance(1);
    const release = await f.vault.getReleaseVerifierProvenance(1);
    expect(spend.verifier).to.equal(await f.spendVerifier.getAddress());
    expect(release.verifier).to.equal(await f.releaseVerifier.getAddress());
    expect(spend.circuitArtifactHash).to.not.equal(release.circuitArtifactHash);
    expect(spend.verificationKeyHash).to.not.equal(release.verificationKeyHash);
  });

  it("rejects release while the exact allocated order authorization is still current", async function () {
    const f = await fixture();
    const allocation = await spend(f, "current-order", 1001n, 2002n, 5001n, 3003n);
    const request = releaseRequest(allocation.allocationId);

    await expect(f.vault.connect(f.factorySigner).releaseCapacity(request, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "AllocationStillAuthorized")
      .withArgs(allocation.allocationId);
  });

  it("restores capacity exactly once after buyer cancellation and records an immutable release receipt", async function () {
    const f = await fixture();
    const allocation = await spend(f, "cancelled-order", 1001n, 2002n, 5001n, 3003n);
    await cancelOrder(f, allocation.order.orderId);
    const request = releaseRequest(allocation.allocationId);

    await expect(f.vault.connect(f.factorySigner).releaseCapacity(request, ZERO_A, ZERO_B, ZERO_C))
      .to.emit(f.vault, "CapacityReleased");

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(1001n);
    expect(await f.vault.releasedAllocations(allocation.allocationId)).to.equal(true);
    expect(await f.vault.usedReleaseNullifiers(8008n)).to.equal(true);

    const receipt = await f.vault.getCapacityRelease(allocation.allocationId);
    expect(receipt.allocationId).to.equal(allocation.allocationId);
    expect(receipt.previousCommitment).to.equal(2002n);
    expect(receipt.restoredCommitment).to.equal(1001n);
    expect(receipt.releaseNullifier).to.equal(8008n);
    expect(receipt.releaseCircuitVersion).to.equal(1n);

    expect(
      await f.vault.isCapacityAllocationAuthorized(
        allocation.allocationId,
        allocation.order.orderId,
        f.factoryId,
        f.periodId,
        f.processId,
        5001n,
        f.policyHash,
      ),
    ).to.equal(false);

    await expect(f.vault.connect(f.factorySigner).releaseCapacity(request, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "AllocationAlreadyReleased")
      .withArgs(allocation.allocationId);
  });

  it("allows release after a buyer amendment makes the historical allocation commitment stale", async function () {
    const f = await fixture();
    const allocation = await spend(f, "amended-order", 1001n, 2002n, 5001n, 3003n);
    await amendOrder(f, allocation.order.orderId, 5002n);

    await f.vault.connect(f.factorySigner).releaseCapacity(
      releaseRequest(allocation.allocationId),
      ZERO_A,
      ZERO_B,
      ZERO_C,
    );
    expect((await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId)).activeCommitment).to.equal(1001n);
  });

  it("rejects a release proof built against a stale canonical capacity commitment", async function () {
    const f = await fixture();
    const first = await spend(f, "first-order", 1001n, 2002n, 5001n, 3003n);
    await cancelOrder(f, first.order.orderId);
    await spend(f, "second-order", 2002n, 2500n, 6001n, 4004n);

    await expect(
      f.vault.connect(f.factorySigner).releaseCapacity(
        releaseRequest(first.allocationId, 2002n, 1001n, 8008n),
        ZERO_A,
        ZERO_B,
        ZERO_C,
      ),
    )
      .to.be.revertedWithCustomError(f.vault, "StaleCapacityState")
      .withArgs(2500n, 2002n);
  });

  it("does not mutate state when the release verifier rejects the proof", async function () {
    const f = await fixture();
    const allocation = await spend(f, "bad-release-proof", 1001n, 2002n, 5001n, 3003n);
    await cancelOrder(f, allocation.order.orderId);
    await f.releaseVerifier.setResult(false);

    await expect(
      f.vault.connect(f.factorySigner).releaseCapacity(
        releaseRequest(allocation.allocationId),
        ZERO_A,
        ZERO_B,
        ZERO_C,
      ),
    ).to.be.revertedWithCustomError(f.vault, "InvalidReleaseProof");

    expect((await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId)).activeCommitment).to.equal(2002n);
    expect(await f.vault.releasedAllocations(allocation.allocationId)).to.equal(false);
    expect(await f.vault.usedReleaseNullifiers(8008n)).to.equal(false);
  });

  it("rejects release submission from an unrelated account", async function () {
    const f = await fixture();
    const allocation = await spend(f, "unauthorized-release", 1001n, 2002n, 5001n, 3003n);
    await cancelOrder(f, allocation.order.orderId);

    await expect(
      f.vault.connect(f.attacker).releaseCapacity(
        releaseRequest(allocation.allocationId),
        ZERO_A,
        ZERO_B,
        ZERO_C,
      ),
    )
      .to.be.revertedWithCustomError(f.vault, "UnauthorizedFactoryCaller")
      .withArgs(f.factoryId, f.attacker.address);
  });

  it("rejects reuse of a release-domain nullifier across distinct allocations", async function () {
    const f = await fixture();
    const first = await spend(f, "release-nullifier-one", 1001n, 2002n, 5001n, 3003n);
    await cancelOrder(f, first.order.orderId);
    await f.vault.connect(f.factorySigner).releaseCapacity(
      releaseRequest(first.allocationId, 2002n, 1001n, 8008n),
      ZERO_A,
      ZERO_B,
      ZERO_C,
    );

    const second = await spend(f, "release-nullifier-two", 1001n, 2002n, 6001n, 4004n);
    await cancelOrder(f, second.order.orderId);
    await expect(
      f.vault.connect(f.factorySigner).releaseCapacity(
        releaseRequest(second.allocationId, 2002n, 1001n, 8008n),
        ZERO_A,
        ZERO_B,
        ZERO_C,
      ),
    )
      .to.be.revertedWithCustomError(f.vault, "ReleaseNullifierAlreadyUsed")
      .withArgs(8008n);
  });
});
