import { expect } from "chai";
import { ethers } from "hardhat";

describe("CredentialRegistry", function () {
  async function fixture() {
    const [admin, auditorSigner, factorySigner, outsider] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ThreadProofRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    const auditorId = ethers.keccak256(ethers.toUtf8Bytes("auditor-one"));
    const factoryId = ethers.keccak256(ethers.toUtf8Bytes("factory-alpha"));
    await registry.registerOrganization(auditorId, auditorSigner.address, 3, ethers.ZeroHash);
    await registry.registerOrganization(factoryId, factorySigner.address, 2, ethers.ZeroHash);

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentials = await CredentialRegistry.deploy(admin.address, await registry.getAddress());
    await credentials.waitForDeployment();
    await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorSigner.address);

    const latest = await ethers.provider.getBlock("latest");
    const now = BigInt(latest!.timestamp);
    const credentialType = ethers.keccak256(ethers.toUtf8Bytes("CAPACITY_CREDENTIAL"));
    const digest = ethers.keccak256(ethers.toUtf8Bytes("credential-body"));
    const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("scope-v1"));

    return {
      admin,
      auditorSigner,
      factorySigner,
      outsider,
      registry,
      credentials,
      auditorId,
      factoryId,
      now,
      credentialType,
      digest,
      scopeHash,
    };
  }

  it("issues an attributable credential and validates its exact subject/type/scope binding", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-1"));

    await expect(
      f.credentials.connect(f.auditorSigner).issueCredential(
        credentialId,
        f.factoryId,
        f.credentialType,
        f.digest,
        f.scopeHash,
        f.now - 60n,
        f.now + 3_600n
      )
    ).to.emit(f.credentials, "CredentialIssued");

    const record = await f.credentials.getCredential(credentialId);
    expect(record.subjectOrganizationId).to.equal(f.factoryId);
    expect(record.issuerOrganizationId).to.equal(f.auditorId);
    expect(record.credentialType).to.equal(f.credentialType);
    expect(record.scopeHash).to.equal(f.scopeHash);
    expect(await f.credentials.isCredentialActive(credentialId)).to.equal(true);
    expect(
      await f.credentials.isCredentialValidFor(
        credentialId,
        f.factoryId,
        f.credentialType,
        f.scopeHash
      )
    ).to.equal(true);

    expect(
      await f.credentials.isCredentialValidFor(
        credentialId,
        ethers.keccak256(ethers.toUtf8Bytes("another-factory")),
        f.credentialType,
        f.scopeHash
      )
    ).to.equal(false);
  });

  it("rejects issuance to an unknown or inactive subject organization", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-unknown-subject"));
    const unknownSubject = ethers.keccak256(ethers.toUtf8Bytes("unknown-factory"));

    await expect(
      f.credentials.connect(f.auditorSigner).issueCredential(
        credentialId,
        unknownSubject,
        f.credentialType,
        f.digest,
        f.scopeHash,
        f.now - 60n,
        f.now + 3_600n
      )
    )
      .to.be.revertedWithCustomError(f.credentials, "InactiveSubject")
      .withArgs(unknownSubject);

    await f.registry.setOrganizationStatus(f.factoryId, 2);
    await expect(
      f.credentials.connect(f.auditorSigner).issueCredential(
        credentialId,
        f.factoryId,
        f.credentialType,
        f.digest,
        f.scopeHash,
        f.now - 60n,
        f.now + 3_600n
      )
    )
      .to.be.revertedWithCustomError(f.credentials, "InactiveSubject")
      .withArgs(f.factoryId);
  });

  it("treats an expired credential as inactive", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-expiring"));

    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      f.credentialType,
      f.digest,
      f.scopeHash,
      f.now - 60n,
      f.now + 10n
    );

    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(f.now + 11n)]);
    await ethers.provider.send("evm_mine", []);

    expect(await f.credentials.isCredentialActive(credentialId)).to.equal(false);
  });

  it("enforces suspension and revocation immediately for new authorization", async function () {
    const f = await fixture();
    const suspendedId = ethers.keccak256(ethers.toUtf8Bytes("credential-suspended"));
    const revokedId = ethers.keccak256(ethers.toUtf8Bytes("credential-revoked"));

    for (const credentialId of [suspendedId, revokedId]) {
      await f.credentials.connect(f.auditorSigner).issueCredential(
        credentialId,
        f.factoryId,
        f.credentialType,
        f.digest,
        f.scopeHash,
        f.now - 60n,
        f.now + 3_600n
      );
    }

    await f.credentials.setCredentialStatus(suspendedId, 2);
    expect(await f.credentials.isCredentialActive(suspendedId)).to.equal(false);

    await f.credentials.connect(f.auditorSigner).revokeCredential(revokedId);
    expect(await f.credentials.isCredentialActive(revokedId)).to.equal(false);
    const revoked = await f.credentials.getCredential(revokedId);
    expect(revoked.status).to.equal(3);
  });

  it("allows a privileged suspender to restore a suspended credential", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-restorable"));
    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      f.credentialType,
      f.digest,
      f.scopeHash,
      f.now - 60n,
      f.now + 3_600n
    );

    await expect(f.credentials.setCredentialStatus(credentialId, 2))
      .to.emit(f.credentials, "CredentialStatusChanged")
      .withArgs(credentialId, 1, 2);
    expect(await f.credentials.isCredentialActive(credentialId)).to.equal(false);

    await expect(f.credentials.setCredentialStatus(credentialId, 1))
      .to.emit(f.credentials, "CredentialStatusChanged")
      .withArgs(credentialId, 2, 1);
    expect(await f.credentials.isCredentialActive(credentialId)).to.equal(true);
  });

  it("makes revocation terminal and rejects ambiguous same-state writes", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-terminal-revocation"));
    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      f.credentialType,
      f.digest,
      f.scopeHash,
      f.now - 60n,
      f.now + 3_600n
    );

    await expect(f.credentials.setCredentialStatus(credentialId, 1))
      .to.be.revertedWithCustomError(f.credentials, "InvalidStatusTransition")
      .withArgs(1, 1);

    await f.credentials.connect(f.auditorSigner).revokeCredential(credentialId);
    await expect(f.credentials.setCredentialStatus(credentialId, 1))
      .to.be.revertedWithCustomError(f.credentials, "InvalidStatusTransition")
      .withArgs(3, 1);
    await expect(f.credentials.setCredentialStatus(credentialId, 2))
      .to.be.revertedWithCustomError(f.credentials, "InvalidStatusTransition")
      .withArgs(3, 2);
    await expect(f.credentials.connect(f.auditorSigner).revokeCredential(credentialId))
      .to.be.revertedWithCustomError(f.credentials, "InvalidStatusTransition")
      .withArgs(3, 3);
  });

  it("does not let an unrelated organization revoke another issuer's credential", async function () {
    const f = await fixture();
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes("credential-protected"));

    await f.credentials.connect(f.auditorSigner).issueCredential(
      credentialId,
      f.factoryId,
      f.credentialType,
      f.digest,
      f.scopeHash,
      f.now - 60n,
      f.now + 3_600n
    );

    await expect(f.credentials.connect(f.outsider).revokeCredential(credentialId))
      .to.be.revertedWithCustomError(f.credentials, "UnauthorizedIssuer")
      .withArgs(credentialId);
  });
});
