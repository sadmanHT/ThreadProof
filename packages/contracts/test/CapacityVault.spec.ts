import { expect } from "chai";
import { ethers, network } from "hardhat";

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

describe("CapacityVault", function () {
  async function fixture() {
    const [admin, buyerSigner, factorySigner, auditorSigner, attacker, otherFactorySigner, relayer] =
      await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const buyerId = ethers.keccak256(ethers.toUtf8Bytes("buyer-one"));
    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha"));
    const otherFactoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-beta"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("auditor-one"));
    await registry.registerOrganization(buyerId, buyerSigner.address, 1, ethers.ZeroHash);
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(otherFactoryId, otherFactorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);

    const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
    const orders = await OrderRegistry.deploy(await registry.getAddress());
    await orders.waitForDeployment();

    const networkInfo = await ethers.provider.getNetwork();
    const orderDomain = {
      name: "ThreadProof OrderRegistry",
      version: "1",
      chainId: networkInfo.chainId,
      verifyingContract: await orders.getAddress(),
    };

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
    const capacityCredentialId = ethers.keccak256(ethers.toUtf8Bytes("capacity-credential-alpha-oct-sewing"));
    const capacityCredentialType = await vault.CAPACITY_CREDENTIAL_TYPE();
    const scopeHash = await vault.capacityCredentialScopeHash(
      factoryId,
      periodId,
      processId,
      policyHash,
      initialCommitment
    );

    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    await credentials.connect(auditorSigner).issueCredential(
      capacityCredentialId,
      factoryId,
      capacityCredentialType,
      ethers.keccak256(ethers.toUtf8Bytes("credential-body")),
      scopeHash,
      now - 60n,
      now + 86_400n
    );

    await vault.connect(auditorSigner).certifyCapacity(
      factoryId,
      periodId,
      processId,
      initialCommitment,
      capacityCredentialId,
      policyHash,
      1
    );

    return {
      admin,
      buyerSigner,
      factorySigner,
      auditorSigner,
      attacker,
      otherFactorySigner,
      relayer,
      registry,
      credentials,
      orders,
      orderDomain,
      verifier,
      vault,
      buyerId,
      factoryId,
      otherFactoryId,
      capacityCredentialId,
      capacityCredentialType,
      periodId,
      processId,
      policyHash,
      initialCommitment,
      now,
    };
  }

  function request(
    values: Awaited<ReturnType<typeof fixture>>,
    oldCapacityCommitment: bigint,
    newCapacityCommitment: bigint,
    nullifier: bigint,
    orderLabel: string
  ) {
    return {
      factoryOrganizationId: values.factoryId,
      periodId: values.periodId,
      processId: values.processId,
      orderId: ethers.keccak256(ethers.toUtf8Bytes(orderLabel)),
      policyHash: values.policyHash,
      oldCapacityCommitment,
      newCapacityCommitment,
      orderCommitment: newCapacityCommitment + 10_000n,
      nullifier,
      circuitVersion: 1,
    };
  }

  async function registerOrder(
    values: Awaited<ReturnType<typeof fixture>>,
    orderId: string,
    orderCommitment: bigint
  ) {
    const latest = await ethers.provider.getBlock("latest");
    const nonce = await values.orders.nonces(values.buyerId);
    const authorization = {
      orderId,
      buyerOrganizationId: values.buyerId,
      primaryFactoryOrganizationId: values.factoryId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment,
      policyHash: values.policyHash,
      nonce,
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await values.buyerSigner.signTypedData(values.orderDomain, ORDER_TYPES, authorization);
    await values.orders.connect(values.relayer).submitOrderVersion(authorization, signature);
    return authorization;
  }

  async function amendOrder(
    values: Awaited<ReturnType<typeof fixture>>,
    orderId: string,
    orderCommitment: bigint
  ) {
    const state = await values.orders.getOrder(orderId);
    const latest = await ethers.provider.getBlock("latest");
    const nonce = await values.orders.nonces(values.buyerId);
    const authorization = {
      orderId,
      buyerOrganizationId: values.buyerId,
      primaryFactoryOrganizationId: values.factoryId,
      version: Number(state.currentVersion) + 1,
      previousVersionHash: state.currentVersionHash,
      orderCommitment,
      policyHash: values.policyHash,
      nonce,
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await values.buyerSigner.signTypedData(values.orderDomain, ORDER_TYPES, authorization);
    await values.orders.connect(values.relayer).submitOrderVersion(authorization, signature);
    return authorization;
  }

  async function cancelOrder(values: Awaited<ReturnType<typeof fixture>>, orderId: string) {
    const state = await values.orders.getOrder(orderId);
    const latest = await ethers.provider.getBlock("latest");
    const cancellation = {
      orderId,
      buyerOrganizationId: values.buyerId,
      expectedVersion: Number(state.currentVersion),
      nonce: await values.orders.nonces(values.buyerId),
      deadline: BigInt(latest!.timestamp) + 3_600n,
    };
    const signature = await values.buyerSigner.signTypedData(values.orderDomain, CANCEL_TYPES, cancellation);
    await values.orders.connect(values.relayer).cancelOrder(cancellation, signature);
  }

  async function deployUninitializedVault(values: Awaited<ReturnType<typeof fixture>>) {
    const Vault = await ethers.getContractFactory("CapacityVault");
    const vault = await Vault.deploy(
      values.admin.address,
      await values.credentials.getAddress(),
      await values.orders.getAddress(),
      await values.registry.getAddress()
    );
    await vault.waitForDeployment();
    await vault.registerVerifier(1, await values.verifier.getAddress());
    await vault.grantRole(await vault.CERTIFIER_ROLE(), values.auditorSigner.address);
    return vault;
  }

  it("atomically advances the canonical commitment and consumes the nullifier for the current signed order", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, spend.orderId, spend.orderCommitment);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.emit(f.vault, "CapacitySpent");

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(2002n);
    expect(await f.vault.usedNullifiers(3003n)).to.equal(true);
  });

  it("serializes two valid same-state spends so exactly one finalizes", async function () {
    const f = await fixture();
    const spendA = request(f, f.initialCommitment, 2002n, 3003n, "concurrent-order-a");
    const spendB = request(f, f.initialCommitment, 4004n, 5005n, "concurrent-order-b");
    await registerOrder(f, spendA.orderId, spendA.orderCommitment);
    await registerOrder(f, spendB.orderId, spendB.orderCommitment);

    await network.provider.send("evm_setAutomine", [false]);
    try {
      const firstNonce = await f.factorySigner.getNonce("pending");
      const txA = await f.vault
        .connect(f.factorySigner)
        .spendCapacity(spendA, ZERO_A, ZERO_B, ZERO_C, { gasLimit: 1_500_000, nonce: firstNonce });
      const txB = await f.vault
        .connect(f.factorySigner)
        .spendCapacity(spendB, ZERO_A, ZERO_B, ZERO_C, { gasLimit: 1_500_000, nonce: firstNonce + 1 });

      await network.provider.send("evm_mine");

      const receiptA = await ethers.provider.getTransactionReceipt(txA.hash);
      const receiptB = await ethers.provider.getTransactionReceipt(txB.hash);
      expect(receiptA).to.not.equal(null);
      expect(receiptB).to.not.equal(null);
      expect([receiptA!.status, receiptB!.status].sort()).to.deep.equal([0, 1]);

      const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
      expect([2002n, 4004n]).to.include(state.activeCommitment);
      const usedCount = Number(await f.vault.usedNullifiers(3003n)) + Number(await f.vault.usedNullifiers(5005n));
      expect(usedCount).to.equal(1);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
  });

  it("rejects a second spend of a stale capacity commitment even if the verifier returns true", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, spend.orderId, spend.orderCommitment);
    await f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "StaleCapacityState")
      .withArgs(2002n, f.initialCommitment);
  });

  it("rejects nullifier replay against a new current order and capacity state", async function () {
    const f = await fixture();
    const first = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, first.orderId, first.orderCommitment);
    await f.vault.connect(f.factorySigner).spendCapacity(first, ZERO_A, ZERO_B, ZERO_C);

    const replay = request(f, 2002n, 4004n, 3003n, "order-2");
    await registerOrder(f, replay.orderId, replay.orderCommitment);
    await expect(f.vault.connect(f.factorySigner).spendCapacity(replay, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "NullifierAlreadyUsed")
      .withArgs(3003n);
  });

  it("rejects submission by an unrelated organization/account", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, spend.orderId, spend.orderCommitment);

    await expect(f.vault.connect(f.attacker).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "UnauthorizedFactoryCaller")
      .withArgs(f.factoryId, f.attacker.address);
  });

  it("rejects a new spend after the underlying capacity credential is revoked", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, spend.orderId, spend.orderCommitment);
    await f.credentials.connect(f.auditorSigner).revokeCredential(f.capacityCredentialId);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidCredential")
      .withArgs(f.capacityCredentialId);
  });

  it("rejects a mathematically invalid proof before mutating capacity state", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await registerOrder(f, spend.orderId, spend.orderCommitment);
    await f.verifier.setResult(false);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidProof");

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(f.initialCommitment);
    expect(await f.vault.usedNullifiers(3003n)).to.equal(false);
  });

  it("rejects an otherwise valid proof for an order that was never buyer-authorized", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "unknown-order");

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidOrderAuthorization")
      .withArgs(spend.orderId);
  });

  it("invalidates an old PoFC order commitment after a buyer amendment becomes current", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-amended");
    await registerOrder(f, spend.orderId, spend.orderCommitment);
    await amendOrder(f, spend.orderId, spend.orderCommitment + 1n);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidOrderAuthorization")
      .withArgs(spend.orderId);

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(f.initialCommitment);
    expect(await f.vault.usedNullifiers(spend.nullifier)).to.equal(false);
  });

  it("invalidates capacity authorization immediately when the buyer cancels the order", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-cancelled");
    await registerOrder(f, spend.orderId, spend.orderCommitment);
    await cancelOrder(f, spend.orderId);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidOrderAuthorization")
      .withArgs(spend.orderId);
  });

  it("rejects a capacity credential issued to a different factory", async function () {
    const f = await fixture();
    const vault = await deployUninitializedVault(f);
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("wrong-subject-credential"));
    const scopeHash = await vault.capacityCredentialScopeHash(
      f.factoryId,
      f.periodId,
      f.processId,
      f.policyHash,
      5005n
    );

    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.otherFactoryId,
      f.capacityCredentialType,
      ethers.keccak256(ethers.toUtf8Bytes("wrong-subject-body")),
      scopeHash,
      f.now - 60n,
      f.now + 86_400n
    );

    await expect(
      vault.connect(f.auditorSigner).certifyCapacity(
        f.factoryId,
        f.periodId,
        f.processId,
        5005n,
        credentialId,
        f.policyHash,
        1
      )
    ).to.be.revertedWithCustomError(vault, "InvalidCredentialBinding");
  });

  it("rejects a credential whose scope was certified for a different period/process/policy/commitment", async function () {
    const f = await fixture();
    const vault = await deployUninitializedVault(f);
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("wrong-scope-credential"));
    const wrongPeriod = ethers.keccak256(ethers.toUtf8Bytes("2026-11"));
    const wrongScopeHash = await vault.capacityCredentialScopeHash(
      f.factoryId,
      wrongPeriod,
      f.processId,
      f.policyHash,
      6006n
    );

    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      f.capacityCredentialType,
      ethers.keccak256(ethers.toUtf8Bytes("wrong-scope-body")),
      wrongScopeHash,
      f.now - 60n,
      f.now + 86_400n
    );

    const expectedScope = await vault.capacityCredentialScopeHash(
      f.factoryId,
      f.periodId,
      f.processId,
      f.policyHash,
      6006n
    );
    await expect(
      vault.connect(f.auditorSigner).certifyCapacity(
        f.factoryId,
        f.periodId,
        f.processId,
        6006n,
        credentialId,
        f.policyHash,
        1
      )
    )
      .to.be.revertedWithCustomError(vault, "InvalidCredentialBinding")
      .withArgs(credentialId, expectedScope);
  });

  it("rejects an active non-capacity credential for capacity certification", async function () {
    const f = await fixture();
    const vault = await deployUninitializedVault(f);
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("safety-credential"));
    const commitment = 7007n;
    const scopeHash = await vault.capacityCredentialScopeHash(
      f.factoryId,
      f.periodId,
      f.processId,
      f.policyHash,
      commitment
    );

    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      ethers.keccak256(ethers.toUtf8Bytes("SAFETY_CREDENTIAL")),
      ethers.keccak256(ethers.toUtf8Bytes("safety-body")),
      scopeHash,
      f.now - 60n,
      f.now + 86_400n
    );

    await expect(
      vault.connect(f.auditorSigner).certifyCapacity(
        f.factoryId,
        f.periodId,
        f.processId,
        commitment,
        credentialId,
        f.policyHash,
        1
      )
    ).to.be.revertedWithCustomError(vault, "InvalidCredentialBinding");
  });
});
