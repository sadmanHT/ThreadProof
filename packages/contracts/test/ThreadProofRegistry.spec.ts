import { expect } from "chai";
import { ethers } from "hardhat";

describe("ThreadProofRegistry", function () {
  it("registers an organization and rotates its primary account without rewriting identity", async function () {
    const [admin, factorySigner, replacementSigner] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha"));
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha-metadata-v1"));

    await expect(registry.registerOrganization(factoryId, factorySigner.address, 2, metadataHash))
      .to.emit(registry, "OrganizationRegistered")
      .withArgs(factoryId, factorySigner.address, 2, metadataHash);

    expect(await registry.organizationOfAccount(factorySigner.address)).to.equal(factoryId);
    expect(await registry.isActive(factoryId)).to.equal(true);

    await expect(registry.rotatePrimaryAccount(factoryId, replacementSigner.address))
      .to.emit(registry, "OrganizationPrimaryAccountRotated")
      .withArgs(factoryId, factorySigner.address, replacementSigner.address);

    expect(await registry.organizationOfAccount(factorySigner.address)).to.equal(ethers.ZeroHash);
    expect(await registry.organizationOfAccount(replacementSigner.address)).to.equal(factoryId);

    const stored = await registry.getOrganization(factoryId);
    expect(stored.id).to.equal(factoryId);
    expect(stored.primaryAccount).to.equal(replacementSigner.address);
  });

  it("prevents an already assigned account from representing two organizations", async function () {
    const [admin, signer] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const first = ethers.keccak256(ethers.toUtf8Bytes("first-org"));
    const second = ethers.keccak256(ethers.toUtf8Bytes("second-org"));

    await registry.registerOrganization(first, signer.address, 2, ethers.ZeroHash);
    await expect(registry.registerOrganization(second, signer.address, 1, ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "AccountAlreadyAssigned")
      .withArgs(signer.address);
  });

  it("suspends an organization without deleting its historical identity", async function () {
    const [admin, factorySigner] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-beta"));
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);

    await registry.setOrganizationStatus(factoryId, 2);
    expect(await registry.isActive(factoryId)).to.equal(false);

    const stored = await registry.getOrganization(factoryId);
    expect(stored.id).to.equal(factoryId);
    expect(stored.primaryAccount).to.equal(factorySigner.address);
    expect(stored.status).to.equal(2);
  });
});
