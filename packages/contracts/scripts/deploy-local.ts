import { ethers, network } from "hardhat";

async function main() {
  const accounts = (await network.provider.send("eth_accounts")) as string[];
  const deployerAddress = accounts[0];
  if (!deployerAddress) {
    throw new Error("No deployer account is configured for this Hardhat network");
  }

  console.log(`Deploying ThreadProof local contracts on ${network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.warn(
    "DEV ONLY: this script deploys MockCapacitySpendVerifier. It is not a production ZK verifier."
  );

  const Registry = await ethers.getContractFactory("ThreadProofRegistry");
  const registry = await Registry.deploy(deployerAddress);
  await registry.waitForDeployment();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistry.deploy(deployerAddress, await registry.getAddress());
  await credentials.waitForDeployment();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
  const mockVerifier = await MockVerifier.deploy();
  await mockVerifier.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault");
  const capacityVault = await CapacityVault.deploy(
    deployerAddress,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress()
  );
  await capacityVault.waitForDeployment();

  const circuitVersion = 1;
  await (await capacityVault.registerVerifier(circuitVersion, await mockVerifier.getAddress())).wait();

  const SubcontractGovernor = await ethers.getContractFactory("SubcontractGovernor");
  const subcontractGovernor = await SubcontractGovernor.deploy(
    deployerAddress,
    await registry.getAddress(),
    await credentials.getAddress(),
    await orders.getAddress(),
    await capacityVault.getAddress()
  );
  await subcontractGovernor.waitForDeployment();

  const ThreadProofCharter = await ethers.getContractFactory("ThreadProofCharter");
  const charter = await ThreadProofCharter.deploy(
    await registry.getAddress(),
    await credentials.getAddress(),
    await capacityVault.getAddress(),
    await subcontractGovernor.getAddress()
  );
  await charter.waitForDeployment();
  const charterAddress = await charter.getAddress();

  // Local smoke uses the same bootstrap-role retirement shape expected from a reviewed
  // production deployment ceremony. The deployer must not remain an exceptional-power path.
  const defaultAdminRole = ethers.ZeroHash;

  await (await registry.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await registry.grantRole(await registry.SUSPENDER_ROLE(), charterAddress)).wait();
  await (await registry.grantRole(await registry.REGISTRAR_ROLE(), charterAddress)).wait();
  await (await registry.revokeRole(await registry.SUSPENDER_ROLE(), deployerAddress)).wait();
  await (await registry.revokeRole(await registry.REGISTRAR_ROLE(), deployerAddress)).wait();
  await (await registry.revokeRole(defaultAdminRole, deployerAddress)).wait();

  await (await credentials.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await credentials.grantRole(await credentials.SUSPENDER_ROLE(), charterAddress)).wait();
  await (await credentials.revokeRole(await credentials.SUSPENDER_ROLE(), deployerAddress)).wait();
  await (await credentials.revokeRole(defaultAdminRole, deployerAddress)).wait();

  await (await capacityVault.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await capacityVault.grantRole(await capacityVault.VERIFIER_ADMIN_ROLE(), charterAddress)).wait();
  await (await capacityVault.grantRole(await capacityVault.PAUSER_ROLE(), charterAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.CERTIFIER_ROLE(), deployerAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.VERIFIER_ADMIN_ROLE(), deployerAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.PAUSER_ROLE(), deployerAddress)).wait();
  await (await capacityVault.revokeRole(defaultAdminRole, deployerAddress)).wait();

  await (await subcontractGovernor.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await subcontractGovernor.grantRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), charterAddress)).wait();
  await (await subcontractGovernor.grantRole(await subcontractGovernor.PAUSER_ROLE(), charterAddress)).wait();
  await (await subcontractGovernor.revokeRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), deployerAddress)).wait();
  await (await subcontractGovernor.revokeRole(await subcontractGovernor.PAUSER_ROLE(), deployerAddress)).wait();
  await (await subcontractGovernor.revokeRole(defaultAdminRole, deployerAddress)).wait();

  const chainIdHex = (await network.provider.send("eth_chainId")) as string;
  const deployment = {
    network: network.name,
    chainId: BigInt(chainIdHex).toString(),
    deployer: deployerAddress,
    contracts: {
      ThreadProofRegistry: await registry.getAddress(),
      CredentialRegistry: await credentials.getAddress(),
      OrderRegistry: await orders.getAddress(),
      MockCapacitySpendVerifier: await mockVerifier.getAddress(),
      CapacityVault: await capacityVault.getAddress(),
      SubcontractGovernor: await subcontractGovernor.getAddress(),
      ThreadProofCharter: charterAddress,
    },
    verifier: {
      circuitVersion,
      kind: "mock-dev-only",
    },
    governance: {
      kind: "charter-role-diverse",
      bootstrapAdminRetired: true,
      charterBoundTargets: ["ThreadProofRegistry", "CredentialRegistry", "CapacityVault", "SubcontractGovernor"],
      operationalRolesRequireCharterDelegation: ["ISSUER_ROLE", "CERTIFIER_ROLE", "RELAYER_ROLE"],
      exceptionalRolesHeldByCharter: ["REGISTRAR_ROLE", "SUSPENDER_ROLE", "VERIFIER_ADMIN_ROLE", "POLICY_ADMIN_ROLE", "PAUSER_ROLE"],
    },
  };

  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
