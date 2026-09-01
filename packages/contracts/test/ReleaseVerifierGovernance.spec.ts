import { expect } from "chai";
import { ethers } from "hardhat";

const RELEASE_VERIFIER_REGISTRATION = 14;

async function advance(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployFixture() {
  const [admin, buyer, industry, auditor, regulator, labor] = await ethers.getSigners();

  const Registry = await ethers.getContractFactory("ThreadProofRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();

  const ids = {
    buyer: ethers.keccak256(ethers.toUtf8Bytes("release-governance-buyer")),
    industry: ethers.keccak256(ethers.toUtf8Bytes("release-governance-industry")),
    auditor: ethers.keccak256(ethers.toUtf8Bytes("release-governance-auditor")),
    regulator: ethers.keccak256(ethers.toUtf8Bytes("release-governance-regulator")),
    labor: ethers.keccak256(ethers.toUtf8Bytes("release-governance-labor")),
  };

  await registry.registerOrganization(ids.buyer, buyer.address, 1, ethers.ZeroHash);
  await registry.registerOrganization(ids.industry, industry.address, 5, ethers.ZeroHash);
  await registry.registerOrganization(ids.auditor, auditor.address, 3, ethers.ZeroHash);
  await registry.registerOrganization(ids.regulator, regulator.address, 4, ethers.ZeroHash);
  await registry.registerOrganization(ids.labor, labor.address, 6, ethers.ZeroHash);

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
  await credentials.waitForDeployment();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault");
  const vault = await CapacityVault.deploy(
    admin.address,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress(),
  );
  await vault.waitForDeployment();

  const SubcontractGovernor = await ethers.getContractFactory("SubcontractGovernor");
  const subcontract = await SubcontractGovernor.deploy(
    admin.address,
    await registry.getAddress(),
    await credentials.getAddress(),
    await orders.getAddress(),
    await vault.getAddress(),
  );
  await subcontract.waitForDeployment();

  const Charter = await ethers.getContractFactory("ThreadProofCharter");
  const charter = await Charter.deploy(
    await registry.getAddress(),
    await credentials.getAddress(),
    await vault.getAddress(),
    await subcontract.getAddress(),
  );
  await charter.waitForDeployment();

  await vault.grantRole(await vault.VERIFIER_ADMIN_ROLE(), await charter.getAddress());
  await vault.revokeRole(await vault.VERIFIER_ADMIN_ROLE(), admin.address);

  return { buyer, industry, auditor, regulator, labor, charter, vault };
}

async function createProposal(charter: any, signer: any, actionHash: string) {
  const proposalId = await charter
    .connect(signer)
    .createProposal.staticCall(RELEASE_VERIFIER_REGISTRATION, actionHash, ethers.ZeroHash);
  await charter.connect(signer).createProposal(RELEASE_VERIFIER_REGISTRATION, actionHash, ethers.ZeroHash);
  return proposalId;
}

describe("ThreadProofCharter release verifier governance", function () {
  it("appends release verifier registration as type 14 with the verifier supermajority policy", async function () {
    const { charter } = await deployFixture();
    const policy = await charter.policies(RELEASE_VERIFIER_REGISTRATION);
    expect(policy.threshold).to.equal(4);
    expect(policy.eligibleMask).to.equal(31);
    expect(policy.requiredMask).to.equal(12);
    expect(policy.timelockSeconds).to.equal(24 * 60 * 60);
    expect(policy.votingPeriodSeconds).to.equal(7 * 24 * 60 * 60);
  });

  it("registers a release verifier only after 4-of-5 approval, required constituencies, timelock, and exact action binding", async function () {
    const fixture = await deployFixture();
    const { buyer, industry, auditor, regulator, charter, vault } = fixture;
    const MockReleaseVerifier = await ethers.getContractFactory("MockCapacityReleaseVerifier");
    const verifier = await MockReleaseVerifier.deploy();
    await verifier.waitForDeployment();

    const circuitVersion = 901;
    const circuitArtifactHash = ethers.keccak256(ethers.toUtf8Bytes("capacity-release-circuit-v901"));
    const verificationKeyHash = ethers.keccak256(ethers.toUtf8Bytes("capacity-release-vkey-v901"));
    const actionHash = await charter.hashReleaseVerifierRegistrationAction(
      circuitVersion,
      await verifier.getAddress(),
      circuitArtifactHash,
      verificationKeyHash,
    );
    const proposalId = await createProposal(charter, buyer, actionHash);

    await charter.connect(buyer).approveProposal(proposalId);
    await charter.connect(industry).approveProposal(proposalId);
    await charter.connect(auditor).approveProposal(proposalId);
    await charter.connect(regulator).approveProposal(proposalId);

    expect(await charter.getProposalState(proposalId)).to.equal(2);
    await expect(
      charter.executeReleaseVerifierRegistration(
        proposalId,
        circuitVersion,
        await verifier.getAddress(),
        circuitArtifactHash,
        verificationKeyHash,
      ),
    ).to.be.revertedWithCustomError(charter, "ProposalNotExecutable");

    await advance(24 * 60 * 60);
    await expect(
      charter.executeReleaseVerifierRegistration(
        proposalId,
        circuitVersion,
        await verifier.getAddress(),
        circuitArtifactHash,
        verificationKeyHash,
      ),
    )
      .to.emit(charter, "ReleaseVerifierRegistrationAuthorized")
      .withArgs(proposalId, circuitVersion, await verifier.getAddress(), circuitArtifactHash, verificationKeyHash);

    expect(await vault.releaseVerifiers(circuitVersion)).to.equal(await verifier.getAddress());

    const secondVerifier = await MockReleaseVerifier.deploy();
    await secondVerifier.waitForDeployment();
    const secondActionHash = await charter.hashReleaseVerifierRegistrationAction(
      circuitVersion + 1,
      await secondVerifier.getAddress(),
      circuitArtifactHash,
      verificationKeyHash,
    );
    const secondProposalId = await createProposal(charter, buyer, secondActionHash);
    await charter.connect(buyer).approveProposal(secondProposalId);
    await charter.connect(industry).approveProposal(secondProposalId);
    await charter.connect(auditor).approveProposal(secondProposalId);
    await charter.connect(regulator).approveProposal(secondProposalId);
    await advance(24 * 60 * 60);

    const wrongHash = await charter.hashReleaseVerifierRegistrationAction(
      circuitVersion + 2,
      await secondVerifier.getAddress(),
      circuitArtifactHash,
      verificationKeyHash,
    );
    expect(wrongHash).to.not.equal(secondActionHash);
    await expect(
      charter.executeReleaseVerifierRegistration(
        secondProposalId,
        circuitVersion + 2,
        await secondVerifier.getAddress(),
        circuitArtifactHash,
        verificationKeyHash,
      ),
    ).to.be.revertedWithCustomError(charter, "ActionHashMismatch");
  });
});
