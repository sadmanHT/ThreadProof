import { expect } from "chai";
import { ethers } from "hardhat";

const PROPOSAL = {
  suspension: 1,
  restore: 2,
  rotation: 3,
  disclosure: 4,
  policyUpdate: 5,
  factoryOnboarding: 6,
  protocolRoleUpdate: 7,
  verifierRegistration: 8,
  subcontractPolicyRegistration: 9,
  emergencyPause: 10,
  emergencyUnpause: 11,
  credentialSuspension: 12,
  credentialRestore: 13,
} as const;

const EMERGENCY_TARGET = {
  capacityVault: 1,
  subcontractGovernor: 2,
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

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
  await credentials.waitForDeployment();
  await credentials.grantRole(await credentials.ISSUER_ROLE(), auditor.address);

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault");
  const capacityVault = await CapacityVault.deploy(
    admin.address,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress(),
  );
  await capacityVault.waitForDeployment();

  const SubcontractGovernor = await ethers.getContractFactory("SubcontractGovernor");
  const subcontractGovernor = await SubcontractGovernor.deploy(
    admin.address,
    await registry.getAddress(),
    await credentials.getAddress(),
    await orders.getAddress(),
    await capacityVault.getAddress(),
  );
  await subcontractGovernor.waitForDeployment();

  const Charter = await ethers.getContractFactory("ThreadProofCharter");
  const charter = await Charter.deploy(
    await registry.getAddress(),
    await credentials.getAddress(),
    await capacityVault.getAddress(),
    await subcontractGovernor.getAddress(),
  );
  await charter.waitForDeployment();
  const charterAddress = await charter.getAddress();
  const defaultAdminRole = ethers.ZeroHash;

  await registry.grantRole(defaultAdminRole, charterAddress);
  await registry.grantRole(await registry.SUSPENDER_ROLE(), charterAddress);
  await registry.grantRole(await registry.REGISTRAR_ROLE(), charterAddress);
  await registry.revokeRole(await registry.SUSPENDER_ROLE(), admin.address);
  await registry.revokeRole(await registry.REGISTRAR_ROLE(), admin.address);
  await registry.revokeRole(defaultAdminRole, admin.address);

  await credentials.grantRole(defaultAdminRole, charterAddress);
  await credentials.grantRole(await credentials.SUSPENDER_ROLE(), charterAddress);
  await credentials.revokeRole(await credentials.SUSPENDER_ROLE(), admin.address);
  await credentials.revokeRole(defaultAdminRole, admin.address);

  await capacityVault.grantRole(defaultAdminRole, charterAddress);
  await capacityVault.grantRole(await capacityVault.VERIFIER_ADMIN_ROLE(), charterAddress);
  await capacityVault.grantRole(await capacityVault.PAUSER_ROLE(), charterAddress);
  await capacityVault.revokeRole(await capacityVault.CERTIFIER_ROLE(), admin.address);
  await capacityVault.revokeRole(await capacityVault.VERIFIER_ADMIN_ROLE(), admin.address);
  await capacityVault.revokeRole(await capacityVault.PAUSER_ROLE(), admin.address);
  await capacityVault.revokeRole(defaultAdminRole, admin.address);

  await subcontractGovernor.grantRole(defaultAdminRole, charterAddress);
  await subcontractGovernor.grantRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), charterAddress);
  await subcontractGovernor.grantRole(await subcontractGovernor.PAUSER_ROLE(), charterAddress);
  await subcontractGovernor.revokeRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), admin.address);
  await subcontractGovernor.revokeRole(await subcontractGovernor.PAUSER_ROLE(), admin.address);
  await subcontractGovernor.revokeRole(defaultAdminRole, admin.address);

  return {
    admin,
    buyer,
    industry,
    auditor,
    regulator,
    labor,
    targetFactory,
    replacement,
    independent,
    applicant,
    registry,
    credentials,
    orders,
    capacityVault,
    subcontractGovernor,
    charter,
    ids,
  };
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

async function approveFour(charter: any, proposalId: string, fixture: Awaited<ReturnType<typeof deployFixture>>) {
  await charter.connect(fixture.buyer).approveProposal(proposalId);
  await charter.connect(fixture.industry).approveProposal(proposalId);
  await charter.connect(fixture.auditor).approveProposal(proposalId);
  await charter.connect(fixture.regulator).approveProposal(proposalId);
}

async function advance(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
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

    await advance(6 * 60 * 60);
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
    await advance(6 * 60 * 60);

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
    await advance(60 * 60);

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

    await advance(24 * 60 * 60);
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
    await advance(2 * 24 * 60 * 60 + 1);

    expect(await charter.getProposalState(proposalId)).to.equal(6);
    await expect(charter.connect(regulator).approveProposal(proposalId))
      .to.be.revertedWithCustomError(charter, "ProposalExpired")
      .withArgs(proposalId);
  });

  it("retires deployer bootstrap authority across governed protocol contracts", async function () {
    const { admin, charter, registry, credentials, capacityVault, subcontractGovernor, ids } = await deployFixture();
    const charterAddress = await charter.getAddress();

    expect(await registry.hasRole(ethers.ZeroHash, admin.address)).to.equal(false);
    expect(await credentials.hasRole(ethers.ZeroHash, admin.address)).to.equal(false);
    expect(await capacityVault.hasRole(ethers.ZeroHash, admin.address)).to.equal(false);
    expect(await subcontractGovernor.hasRole(ethers.ZeroHash, admin.address)).to.equal(false);

    expect(await registry.hasRole(ethers.ZeroHash, charterAddress)).to.equal(true);
    expect(await credentials.hasRole(ethers.ZeroHash, charterAddress)).to.equal(true);
    expect(await capacityVault.hasRole(ethers.ZeroHash, charterAddress)).to.equal(true);
    expect(await subcontractGovernor.hasRole(ethers.ZeroHash, charterAddress)).to.equal(true);

    await expect(registry.connect(admin).setOrganizationStatus(ids.target, 2)).to.be.reverted;
    await expect(capacityVault.connect(admin).pause()).to.be.reverted;
    await expect(subcontractGovernor.connect(admin).pause()).to.be.reverted;
  });

  it("delegates only narrowly allowed operational roles through a 4-of-5 timelocked action", async function () {
    const fixture = await deployFixture();
    const { buyer, independent, replacement, credentials, capacityVault, charter } = fixture;
    const issuerRole = await credentials.ISSUER_ROLE();
    const pauserRole = await capacityVault.PAUSER_ROLE();

    const allowedHash = await charter.hashProtocolRoleAction(
      await credentials.getAddress(),
      issuerRole,
      independent.address,
      true,
    );
    const allowedId = await createProposal(charter, buyer, PROPOSAL.protocolRoleUpdate, allowedHash);

    const forbiddenHash = await charter.hashProtocolRoleAction(
      await capacityVault.getAddress(),
      pauserRole,
      replacement.address,
      true,
    );
    const forbiddenId = await createProposal(charter, buyer, PROPOSAL.protocolRoleUpdate, forbiddenHash);

    await approveFour(charter, allowedId, fixture);
    await approveFour(charter, forbiddenId, fixture);
    await advance(24 * 60 * 60);

    await charter.executeProtocolRoleUpdate(
      allowedId,
      await credentials.getAddress(),
      issuerRole,
      independent.address,
      true,
    );
    expect(await credentials.hasRole(issuerRole, independent.address)).to.equal(true);

    await expect(
      charter.executeProtocolRoleUpdate(
        forbiddenId,
        await capacityVault.getAddress(),
        pauserRole,
        replacement.address,
        true,
      ),
    ).to.be.revertedWithCustomError(charter, "InvalidProtocolRoleAction");
  });

  it("registers verifier provenance only after 4-of-5 Charter approval and timelock", async function () {
    const fixture = await deployFixture();
    const { buyer, charter, capacityVault } = fixture;
    const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();

    const circuitVersion = 77;
    const circuitArtifactHash = ethers.keccak256(ethers.toUtf8Bytes("capacity-spend-circuit-v77"));
    const verificationKeyHash = ethers.keccak256(ethers.toUtf8Bytes("capacity-spend-vkey-v77"));
    const actionHash = await charter.hashVerifierRegistrationAction(
      circuitVersion,
      await verifier.getAddress(),
      circuitArtifactHash,
      verificationKeyHash,
    );
    const proposalId = await createProposal(charter, buyer, PROPOSAL.verifierRegistration, actionHash);
    await approveFour(charter, proposalId, fixture);

    await expect(
      charter.executeVerifierRegistration(
        proposalId,
        circuitVersion,
        await verifier.getAddress(),
        circuitArtifactHash,
        verificationKeyHash,
      ),
    ).to.be.revertedWithCustomError(charter, "ProposalNotExecutable");

    await advance(24 * 60 * 60);
    await charter.executeVerifierRegistration(
      proposalId,
      circuitVersion,
      await verifier.getAddress(),
      circuitArtifactHash,
      verificationKeyHash,
    );
    expect(await capacityVault.verifiers(circuitVersion)).to.equal(await verifier.getAddress());
  });

  it("registers subcontract policy only through the supermajority Charter path", async function () {
    const fixture = await deployFixture();
    const { industry, charter, subcontractGovernor } = fixture;
    const policyHash = ethers.keccak256(ethers.toUtf8Bytes("subcontract-policy-v2"));
    const complianceType = ethers.keccak256(ethers.toUtf8Bytes("FACTORY_COMPLIANCE"));
    const processType = ethers.keccak256(ethers.toUtf8Bytes("SEWING_PROCESS"));
    const actionHash = await charter.hashSubcontractPolicyAction(policyHash, 3, complianceType, processType);
    const proposalId = await createProposal(charter, industry, PROPOSAL.subcontractPolicyRegistration, actionHash);
    await approveFour(charter, proposalId, fixture);
    await advance(24 * 60 * 60);

    await charter.executeSubcontractPolicyRegistration(proposalId, policyHash, 3, complianceType, processType);
    const stored = await subcontractGovernor.getPolicy(policyHash);
    expect(stored.maxDepth).to.equal(3);
    expect(stored.complianceCredentialType).to.equal(complianceType);
    expect(stored.processCredentialType).to.equal(processType);
  });

  it("requires three constituencies to pause and a reviewed timelock to unpause critical protocol paths", async function () {
    const { buyer, auditor, regulator, charter, capacityVault } = await deployFixture();
    const pauseHash = await charter.hashEmergencyControlAction(EMERGENCY_TARGET.capacityVault, true);
    const pauseId = await createProposal(charter, regulator, PROPOSAL.emergencyPause, pauseHash);
    await charter.connect(buyer).approveProposal(pauseId);
    await charter.connect(auditor).approveProposal(pauseId);
    await charter.connect(regulator).approveProposal(pauseId);
    await charter.executeEmergencyControl(pauseId, EMERGENCY_TARGET.capacityVault);
    expect(await capacityVault.paused()).to.equal(true);

    const unpauseHash = await charter.hashEmergencyControlAction(EMERGENCY_TARGET.capacityVault, false);
    const unpauseId = await createProposal(charter, auditor, PROPOSAL.emergencyUnpause, unpauseHash);
    await charter.connect(buyer).approveProposal(unpauseId);
    await charter.connect(auditor).approveProposal(unpauseId);
    await charter.connect(regulator).approveProposal(unpauseId);

    await expect(charter.executeEmergencyControl(unpauseId, EMERGENCY_TARGET.capacityVault))
      .to.be.revertedWithCustomError(charter, "ProposalNotExecutable");
    await advance(6 * 60 * 60);
    await charter.executeEmergencyControl(unpauseId, EMERGENCY_TARGET.capacityVault);
    expect(await capacityVault.paused()).to.equal(false);
  });

  it("governs emergency credential suspension and reviewed restoration without replacing issuer revocation", async function () {
    const { buyer, auditor, regulator, targetFactory, credentials, charter, ids } = await deployFixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-governance-case"));
    const credentialType = ethers.keccak256(ethers.toUtf8Bytes("SAFETY_CREDENTIAL"));
    const digest = ethers.keccak256(ethers.toUtf8Bytes("credential-body"));
    const scope = ethers.keccak256(ethers.toUtf8Bytes("credential-scope"));
    const block = await ethers.provider.getBlock("latest");
    const now = block?.timestamp ?? 1;

    expect(targetFactory.address).to.not.equal(ethers.ZeroAddress);
    await credentials.connect(auditor).issueCredential(
      credentialId,
      ids.target,
      credentialType,
      digest,
      scope,
      now - 1,
      now + 7 * 24 * 60 * 60,
    );

    const suspendHash = await charter.hashCredentialStatusAction(credentialId, 2);
    const suspendId = await createProposal(charter, regulator, PROPOSAL.credentialSuspension, suspendHash);
    await charter.connect(auditor).approveProposal(suspendId);
    await charter.connect(regulator).approveProposal(suspendId);
    await charter.executeCredentialStatus(suspendId, credentialId, 2);
    expect((await credentials.getCredential(credentialId)).status).to.equal(2);

    const restoreHash = await charter.hashCredentialStatusAction(credentialId, 1);
    const restoreId = await createProposal(charter, auditor, PROPOSAL.credentialRestore, restoreHash);
    await charter.connect(buyer).approveProposal(restoreId);
    await charter.connect(auditor).approveProposal(restoreId);
    await charter.connect(regulator).approveProposal(restoreId);
    await expect(charter.executeCredentialStatus(restoreId, credentialId, 1))
      .to.be.revertedWithCustomError(charter, "ProposalNotExecutable");
    await advance(6 * 60 * 60);
    await charter.executeCredentialStatus(restoreId, credentialId, 1);
    expect((await credentials.getCredential(credentialId)).status).to.equal(1);
  });
});
