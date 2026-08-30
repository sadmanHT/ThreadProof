import { ethers, network } from "hardhat";

async function main() {
  const accounts = (await network.provider.send("eth_accounts")) as string[];
  const deployerAddress = accounts[0];
  if (!deployerAddress) throw new Error("No deployer account is configured for this Hardhat network");

  console.log(`Deploying ThreadProof local contracts on ${network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.warn("DEV ONLY: this script deploys MockCapacitySpendVerifier. It is not a production ZK verifier.");

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

  const SubcontractGovernor = await ethers.getContractFactory("SubcontractGovernor");
  const subcontractGovernor = await SubcontractGovernor.deploy(
    deployerAddress,
    await orders.getAddress(),
    await registry.getAddress(),
    await credentials.getAddress(),
    await capacityVault.getAddress()
  );
  await subcontractGovernor.waitForDeployment();

  const circuitVersion = 1;
  await (await capacityVault.registerVerifier(circuitVersion, await mockVerifier.getAddress())).wait();

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
    },
    verifier: { circuitVersion, kind: "mock-dev-only" },
  };

  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
