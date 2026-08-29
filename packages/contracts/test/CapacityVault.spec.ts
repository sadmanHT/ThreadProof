import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_A: [bigint, bigint] = [0n, 0n];
const ZERO_B: [[bigint, bigint], [bigint, bigint]] = [[0n, 0n], [0n, 0n]];
const ZERO_C: [bigint, bigint] = [0n, 0n];

describe("CapacityVault", function () {
  async function fixture() {
    const [admin, factorySigner, auditorSigner, attacker] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha"));
    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("auditor-one"));
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);
    await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);

    const capacityCredentialId = ethers.keccak256(ethers.toUtf8Bytes("capacity-credential-alpha-oct-sewing"));
    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    await credentials.connect(auditorSigner).issueCredential(
      capacityCredentialId,
      factoryId,
      ethers.keccak256(ethers.toUtf8Bytes("CAPACITY_CREDENTIAL")),
      ethers.keccak256(ethers.toUtf8Bytes("credential-body")),
      ethers.keccak256(ethers.toUtf8Bytes("october-sewing")),
      now - 60n,
      now + 86_400n
    );

    const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    const Vault = await ethers.getContractFactory("CapacityVault");
    const vault = await Vault.deploy(admin.address, await credentials.getAddress(), await registry.getAddress());
    await vault.waitForDeployment();
    await vault.registerVerifier(1, await verifier.getAddress());
    await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorSigner.address);

    const periodId = ethers.keccak256(ethers.toUtf8Bytes("2026-10"));
    const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("policy-v1"));
    const initialCommitment = 1001n;

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
      factorySigner,
      auditorSigner,
      attacker,
      registry,
      credentials,
      verifier,
      vault,
      factoryId,
      capacityCredentialId,
      periodId,
      processId,
      policyHash,
      initialCommitment,
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

  it("atomically advances the canonical commitment and consumes the nullifier", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.emit(f.vault, "CapacitySpent");

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(2002n);
    expect(await f.vault.usedNullifiers(3003n)).to.equal(true);
  });

  it("rejects a second spend of a stale capacity commitment even if the verifier returns true", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C);

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "StaleCapacityState")
      .withArgs(2002n, f.initialCommitment);
  });

  it("rejects nullifier replay against the new current state", async function () {
    const f = await fixture();
    const first = request(f, f.initialCommitment, 2002n, 3003n, "order-1");
    await f.vault.connect(f.factorySigner).spendCapacity(first, ZERO_A, ZERO_B, ZERO_C);

    const replay = request(f, 2002n, 4004n, 3003n, "order-2");
    await expect(f.vault.connect(f.factorySigner).spendCapacity(replay, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "NullifierAlreadyUsed")
      .withArgs(3003n);
  });

  it("rejects submission by an unrelated organization/account", async function () {
    const f = await fixture();
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");

    await expect(f.vault.connect(f.attacker).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "UnauthorizedFactoryCaller")
      .withArgs(f.factoryId, f.attacker.address);
  });

  it("rejects a new spend after the underlying capacity credential is revoked", async function () {
    const f = await fixture();
    await f.credentials.connect(f.auditorSigner).revokeCredential(f.capacityCredentialId);
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidCredential")
      .withArgs(f.capacityCredentialId);
  });

  it("rejects a mathematically invalid proof before mutating capacity state", async function () {
    const f = await fixture();
    await f.verifier.setResult(false);
    const spend = request(f, f.initialCommitment, 2002n, 3003n, "order-1");

    await expect(f.vault.connect(f.factorySigner).spendCapacity(spend, ZERO_A, ZERO_B, ZERO_C))
      .to.be.revertedWithCustomError(f.vault, "InvalidProof");

    const state = await f.vault.getCapacityState(f.factoryId, f.periodId, f.processId);
    expect(state.activeCommitment).to.equal(f.initialCommitment);
    expect(await f.vault.usedNullifiers(3003n)).to.equal(false);
  });
});
