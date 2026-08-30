import { expect } from "chai";
import { ethers, network } from "hardhat";

const DEV_CIRCUIT_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const DEV_VK_HASH =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

describe("CapacityVault verifier provenance", function () {
  async function fixture() {
    const [admin] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Vault = await ethers.getContractFactory("CapacityVault");
    // The registry addresses are intentionally inert here: provenance checks run before any
    // external registry call in the certification path exercised by the drift test below.
    const vault = await Vault.deploy(admin.address, admin.address, admin.address, admin.address);
    await vault.waitForDeployment();

    return { admin, Verifier, verifier, vault };
  }

  it("records verifier-supplied provenance and makes a circuit version immutable", async function () {
    const f = await fixture();
    const verifierAddress = await f.verifier.getAddress();
    const runtimeCode = await ethers.provider.getCode(verifierAddress);
    const expectedCodeHash = ethers.keccak256(runtimeCode);

    await expect(f.vault.registerVerifier(1, verifierAddress))
      .to.emit(f.vault, "VerifierProvenanceRegistered")
      .withArgs(1, verifierAddress, DEV_CIRCUIT_HASH, DEV_VK_HASH, expectedCodeHash);

    const provenance = await f.vault.getVerifierProvenance(1);
    expect(provenance.verifier).to.equal(verifierAddress);
    expect(provenance.circuitArtifactHash).to.equal(DEV_CIRCUIT_HASH);
    expect(provenance.verificationKeyHash).to.equal(DEV_VK_HASH);
    expect(provenance.verifierCodeHash).to.equal(expectedCodeHash);
    expect(provenance.registeredAt).to.be.greaterThan(0n);

    const replacement = await f.Verifier.deploy();
    await replacement.waitForDeployment();
    await expect(f.vault.registerVerifier(1, await replacement.getAddress()))
      .to.be.revertedWithCustomError(f.vault, "VerifierAlreadyRegistered")
      .withArgs(1);
  });

  it("supports independently calculated artifact hashes for ceremony tooling", async function () {
    const f = await fixture();
    const circuitHash = ethers.keccak256(ethers.toUtf8Bytes("independently-hashed-r1cs"));
    const verificationKeyHash = ethers.keccak256(ethers.toUtf8Bytes("independently-hashed-vk"));

    await f.vault.registerVerifierWithProvenance(
      7,
      await f.verifier.getAddress(),
      circuitHash,
      verificationKeyHash
    );

    const provenance = await f.vault.getVerifierProvenance(7);
    expect(provenance.circuitArtifactHash).to.equal(circuitHash);
    expect(provenance.verificationKeyHash).to.equal(verificationKeyHash);
  });

  it("rejects zero versions, zero provenance and contracts without provenance metadata", async function () {
    const f = await fixture();
    const verifierAddress = await f.verifier.getAddress();

    await expect(f.vault.registerVerifier(0, verifierAddress))
      .to.be.revertedWithCustomError(f.vault, "InvalidCircuitVersion")
      .withArgs(0);

    await expect(
      f.vault.registerVerifierWithProvenance(
        2,
        verifierAddress,
        ethers.ZeroHash,
        DEV_VK_HASH
      )
    )
      .to.be.revertedWithCustomError(f.vault, "InvalidVerifierProvenance")
      .withArgs(ethers.ZeroHash, DEV_VK_HASH);

    const NonVerifier = await ethers.getContractFactory("MutableThreadProofRegistry");
    const nonVerifier = await NonVerifier.deploy();
    await nonVerifier.waitForDeployment();
    await expect(f.vault.registerVerifier(3, await nonVerifier.getAddress()))
      .to.be.revertedWithCustomError(f.vault, "VerifierMetadataUnavailable")
      .withArgs(await nonVerifier.getAddress());
  });

  it("fails closed if registered verifier runtime bytecode changes", async function () {
    const f = await fixture();
    const verifierAddress = await f.verifier.getAddress();
    await f.vault.registerVerifier(1, verifierAddress);
    const provenance = await f.vault.getVerifierProvenance(1);

    const replacementRuntime = "0x60006000fd";
    await network.provider.send("hardhat_setCode", [verifierAddress, replacementRuntime]);
    const replacementCodeHash = ethers.keccak256(replacementRuntime);

    await expect(
      f.vault.certifyCapacity(
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash,
        1n,
        ethers.ZeroHash,
        ethers.ZeroHash,
        1
      )
    )
      .to.be.revertedWithCustomError(f.vault, "VerifierCodeHashMismatch")
      .withArgs(1, provenance.verifierCodeHash, replacementCodeHash);
  });
});
