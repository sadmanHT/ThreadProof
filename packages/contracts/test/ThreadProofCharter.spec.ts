import { expect } from "chai";
import { ethers } from "hardhat";

const PROPOSAL = {
  suspension: 1,
  restore: 2,
  rotation: 3,
  disclosure: 4,
  policyUpdate: 5,
  factoryOnboarding: 6,
} as const;

async function deployFixture() {
  const [admin, buyer, industry, auditor, regulator, labor, targetFactory, replacement, independent, applicant] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory("ThreadProofRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();

  const ids = {
    buyer: ethers.keccak256(ethers.toUtf8Bytes("governance-buyer")),
    industry: ethers.keccak256(ethers.toUtf8Bytes("governance-industry")),
    auditor: ethers.keccak256(ethers.toUtf8Bytes("governance-auditor")),
    regulator: ethers.keccak256(ethers.toUtf8Bytes("governance-regulator")),
    labor: ethers.keccak256(ethers.toUtf8Bytes("governance-labor")),
    target: ethers.keccak256(ethers.toUtf8Bytes("governance-target-factory")),
    independent: ethers.keccak256(ethers.toUtf8Bytes("governance-independent")),
    applicant: ethers.keccak256(ethers.toUtf8Bytes("factory-onboarding-applicant")),
  };

  await registry.registerOrganization(ids.buyer, buyer.address, 1, ethers.ZeroHash);
  await registry.registerOrganization(ids.industry, industry.address, 5, ethers.ZeroHash);
  await registry.registerOrganization(ids.auditor, auditor.address, 3, ethers.ZeroHash);
  await registry.registerOrganization(ids.regulator, regulator.address, 4, ethers.ZeroHash);
  await registry.registerOrganization(ids.labor, labor.address, 6, ethers.ZeroHash);
  await registry.registerOrganization(ids.target, targetFactory.address, 2, ethers.ZeroHash);
  await registry.registerOrganization(ids.independent, independent.address, 7, ethers.ZeroHash);

  const Charter = await ethers.getContractFactory("ThreadProofCharter");
  const charter = await Charter.deploy(await registry.getAddress());
  await charter.waitForDeployment();

  await registry.grantRole(await registry.SUSPENDER_ROLE(), await charter.getAddress());
  await registry.grantRole(await registry.REGISTRAR_ROLE(), await charter.getAddress());
  await registry.revokeRole(await registry.SUSPENDER_ROLE(), admin.address);
  await registry.revokeRole(await registry.REGISTRAR_ROLE(), admin.address);

  return { admin, buyer, industry, auditor, regulator, labor, targetFactory, replacement, independent, applicant, registry, charter, ids };
}

async function createProposal(
  charter: any,
  signer: any,
  proposalType: number,
  actionHash: string,
  metadata = ethers.ZeroHash,
) {
  const proposalId = await charter.connect(signer).createProposal.staticCall(proposalType, actionHash, metadata);
  await charter.connect(signer).createProposal(proposalType, actionHash, metadata);
  return proposalId;
}

describe("ThreadProofCharter", function () {
  it("requires the regulator and auditor constituencies to suspend an organization", async function () {
    const { buyer, auditor, regulator, registry, charter, ids } = await deployFixture();
    const actionHash = await charter.hashOrganizationStatusAction(ids.target, 2);
    const proposalId = await createProposal(charter, regulator, PROPOSAL.suspension, actionHash);

    await expect(charter.connect(buyer).approveProposal(proposalId))
      .to.be.revertedWithCustomError(charter, "IneligibleConstituency")
      .withArgs(1);

    await charter.connect(regulator).approveProposal(proposalId);
    expect(await charter.getProposalState(proposalId)).to.equal(1);

    await expect(charter.connect(auditor).approveProposal(proposalId))
      .to.emit(charter, "ProposalThresholdReached");
    expect(await charter.getProposalState(proposalId)).to.equal(3);

    await expect(charter.connect(buyer).executeOrganizationStatus(proposalId, ids.target, 2))
      .to.emit(charter, "ProposalExecuted")
      .withArgs(proposalId, PROPOSAL.suspension, buyer.address);
    expect(await registry.isActive(ids.target)).to.equal(false);
    expect(await charter.getProposalState(proposalId)).to.equal(4);
  });

  it("counts at most one approval from each constituency", async function () {
    const { auditor, regulator, independent, charter, ids } = await deployFixture();
    const actionHash = await charter.hashOrganizationStatusAction(ids.target, 2);
    const proposalId = await createProposal(charter, regulator, PROPOSAL.suspension, actionHash);

    await charter.connect(auditor).approveProposal(proposalId);
    await expect(charter.connect(independent).approveProposal(proposalId))
      .to.be.revertedWithCustomError(charter, "ConstituencyAlreadyApproved")
      .withArgs(3);
  });

  it("uses a timelocked three-constituency review to restore a suspended participant", async function () {
    const { buyer, auditor, regulator, registry, charter, ids } = await deployFixture();

    const suspendHash = await charter.hashOrganizationStatusAction(ids.target, 2);
    const suspendId = await createProposal(charter, regulator, PROPOSAL.suspension, suspendHash);
    await charter.connect(regulator).approveProposal(suspendId);
    await charter.connect(auditor).approveProposal(suspendId);
    await charter.executeOrganizationStatus(suspendId, ids.target, 2);

    const restoreHash = await charter.hashOrganizationStatusAction(ids.target, 1);
    const restoreId = await createProposal(charter, auditor, PROPOSAL.restore, restoreHash);
    await charter.connect(buyer).approveProposal(restoreId);
    await charter.connect(auditor).approveProposal(restoreId);
    await charter.connect(regulator).approveProposal(restoreId);

    expect(await charter.getProposalState(restoreId)).to.equal(2);
    await expect(charter.executeOrganizationStatus(restoreId, ids.target, 1))
      .to.be.revertedWithCustomError(charter, "ProposalNotExecutable")
      .withArgs(restoreId);

    await ethers.provider.send("evm_increaseTime", [6 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await charter.executeOrganizationStatus(restoreId, ids.target, 1);
    expect(await registry.isActive(ids.target)).to.equal(true);
  });

  it("governs primary-account recovery without rewriting organization identity", async function () {
    const { buyer, auditor, regulator, replacement, registry, charter, ids } = await deployFixture();
    const actionHash = await charter.hashPrimaryAccountRotationAction(ids.target, replacement.address);
    const proposalId = await createProposal(charter, auditor, PROPOSAL.rotation, actionHash);

    await charter.connect(buyer).approveProposal(proposalId);
    await charter.connect(auditor).approveProposal(proposalId);
    await charter.connect(regulator).approveProposal(proposalId);
    await ethers.provider.send("evm_increaseTime", [6 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await charter.executePrimaryAccountRotation(proposalId, ids.target, replacement.address);
    expect(await registry.organizationOfAccount(replacement.address)).to.equal(ids.target);
    const stored = await registry.getOrganization(ids.target);
    expect(stored.id).to.equal(ids.target);
    expect(stored.primaryAccount).to.equal(replacement.address);
  });

  it("authorizes protected-identity disclosure using opaque references only", async function () {
    const { buyer, auditor, regulator, charter } = await deployFixture();
    const subjectReference = ethers.keccak256(ethers.toUtf8Bytes("protected-subject-pseudonym-17"));
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("investigation-evidence-bundle"));
    const actionHash = await charter.hashProtectedIdentityDisclosureAction(subjectReference, evidenceHash);
    const proposalId = await createProposal(charter, regulator, PROPOSAL.disclosure, actionHash);

    await charter.connect(buyer).approveProposal(proposalId);
    await charter.connect(auditor).approveProposal(proposalId);
    await charter.connect(regulator).approveProposal(proposalId);
    await ethers.provider.send("evm_increaseTime", [60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await expect(charter.executeProtectedIdentityDisclosure(proposalId, subjectReference, evidenceHash))
      .to.emit(charter, "ProtectedIdentityDisclosureAuthorized")
      .withArgs(proposalId, subjectReference, evidenceHash);
  });

  it("onboards a factory only after auditor and industry constituency approval", async function () {
    const { buyer, industry, auditor, regulator, applicant, registry, charter, ids } = await deployFixture();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("factory-applicant-metadata-v1"));
    const actionHash = await charter.hashFactoryOnboardingAction(ids.applicant, applicant.address, metadataHash);
    const proposalId = await createProposal(charter, auditor, PROPOSAL.factoryOnboarding, actionHash, metadataHash);

    await expect(charter.connect(regulator).approveProposal(proposalId))
      .to.be.revertedWithCustomError(charter, "IneligibleConstituency")
      .withArgs(4);

    await charter.connect(industry).approveProposal(proposalId);
    expect(await charter.getProposalState(proposalId)).to.equal(1);

    await expect(charter.connect(auditor).approveProposal(proposalId))
      .to.emit(charter, "ProposalThresholdReached");
    expect(await charter.getProposalState(proposalId)).to.equal(3);

    await expect(charter.connect(buyer).executeFactoryOnboarding(proposalId, ids.applicant, applicant.address, metadataHash))
      .to.emit(charter, "FactoryOnboardingAuthorized")
      .withArgs(proposalId, ids.applicant, applicant.address, metadataHash);

    expect(await registry.isActive(ids.applicant)).to.equal(true);
    expect(await registry.organizationOfAccount(applicant.address)).to.equal(ids.applicant);
    const stored = await registry.getOrganization(ids.applicant);
    expect(stored.role).to.equal(2);
    expect(stored.metadataHash).to.equal(metadataHash);
  });

  it("fails closed if factory onboarding execution does not match the approved account or metadata", async function () {
    const { industry, auditor, applicant, replacement, charter, ids } = await deployFixture();
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("factory-applicant-metadata-v1"));
    const actionHash = await charter.hashFactoryOnboardingAction(ids.applicant, applicant.address, metadataHash);
    const proposalId = await createProposal(charter, industry, PROPOSAL.factoryOnboarding, actionHash, metadataHash);
    await charter.connect(industry).approveProposal(proposalId);
    await charter.connect(auditor).approveProposal(proposalId);

    const actualHash = await charter.hashFactoryOnboardingAction(ids.applicant, replacement.address, metadataHash);
    await expect(charter.executeFactoryOnboarding(proposalId, ids.applicant, replacement.address, metadataHash))
      .to.be.revertedWithCustomError(charter, "ActionHashMismatch")
      .withArgs(actionHash, actualHash);
  });

  it("requires 4-of-5 plus a timelock to change Charter policy and rejects stale amendments", async function () {
    const { buyer, industry, auditor, regulator, labor, charter } = await deployFixture();
    const currentVersion = await charter.policyVersion();
    const newPolicy = {
      threshold: 4,
      eligibleMask: 31,
      requiredMask: 12,
      timelockSeconds: 2 * 60 * 60,
      votingPeriodSeconds: 5 * 24 * 60 * 60,
      exists: true,
    };
    const actionHash = await charter.hashPolicyUpdateAction(
      PROPOSAL.disclosure,
      newPolicy.threshold,
      newPolicy.eligibleMask,
      newPolicy.requiredMask,
      newPolicy.timelockSeconds,
      newPolicy.votingPeriodSeconds,
      currentVersion,
    );
    const proposalId = await createProposal(charter, buyer, PROPOSAL.policyUpdate, actionHash);

    await charter.connect(buyer).approveProposal(proposalId);
    await charter.connect(industry).approveProposal(proposalId);
    await charter.connect(auditor).approveProposal(proposalId);
    expect(await charter.getProposalState(proposalId)).to.equal(1);
    await charter.connect(regulator).approveProposal(proposalId);
    expect(await charter.getProposalState(proposalId)).to.equal(2);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await charter.executePolicyUpdate(proposalId, PROPOSAL.disclosure, newPolicy);
    expect(await charter.policyVersion()).to.equal(currentVersion + 1n);
    const stored = await charter.policies(PROPOSAL.disclosure);
    expect(stored.threshold).to.equal(4);
    expect(stored.requiredMask).to.equal(12);

    const staleHash = await charter.hashPolicyUpdateAction(
      PROPOSAL.rotation,
      3,
      31,
      4,
      21600,
      604800,
      currentVersion,
    );
    const staleId = await createProposal(charter, labor, PROPOSAL.policyUpdate, staleHash);
    const stale = await charter.getProposal(staleId);
    expect(stale.policyVersion).to.equal(currentVersion + 1n);
    expect(stale.actionHash).to.equal(staleHash);
  });

  it("fails closed when an action payload does not match the approved commitment", async function () {
    const { auditor, regulator, charter, ids } = await deployFixture();
    const actionHash = await charter.hashOrganizationStatusAction(ids.target, 2);
    const proposalId = await createProposal(charter, regulator, PROPOSAL.suspension, actionHash);
    await charter.connect(auditor).approveProposal(proposalId);
    await charter.connect(regulator).approveProposal(proposalId);

    const otherOrganization = ethers.keccak256(ethers.toUtf8Bytes("different-target"));
    const actualHash = await charter.hashOrganizationStatusAction(otherOrganization, 2);
    await expect(charter.executeOrganizationStatus(proposalId, otherOrganization, 2))
      .to.be.revertedWithCustomError(charter, "ActionHashMismatch")
      .withArgs(actionHash, actualHash);
  });

  it("expires proposals that do not reach threshold before their voting window closes", async function () {
    const { regulator, charter, ids } = await deployFixture();
    const actionHash = await charter.hashOrganizationStatusAction(ids.target, 2);
    const proposalId = await createProposal(charter, regulator, PROPOSAL.suspension, actionHash);
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    expect(await charter.getProposalState(proposalId)).to.equal(6);
    await expect(charter.connect(regulator).approveProposal(proposalId))
      .to.be.revertedWithCustomError(charter, "ProposalExpired")
      .withArgs(proposalId);
  });
});
