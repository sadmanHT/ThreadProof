import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer is configured for this Hardhat network");
  }

  console.log(`Deploying ThreadProof local contracts on ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.warn(
    "DEV ONLY: this script deploys MockCapacitySpendVerifier. It is not a production ZK verifier."
  );

  const Registry = await ethers.getContractFactory("ThreadProofRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistry.deploy(deployer.address, await registry.getAddress());
  await credentials.waitForDeployment();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry");
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier");
  const mockVerifier = await MockVerifier.deploy();
  await mockVerifier.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault");
  const capacityVault = await CapacityVault.deploy(
    deployer.address,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress()
  );
  await capacityVault.waitForDeployment();

  const circuitVersion = 1;
  await (await capacityVault.registerVerifier(circuitVersion, await mockVerifier.getAddress())).wait();

  const chain = await ethers.provider.getNetwork();
  const deployment = {
    network: network.name,
    chainId: chain.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      ThreadProofRegistry: await registry.getAddress(),
      CredentialRegistry: await credentials.getAddress(),
      OrderRegistry: await orders.getAddress(),
      MockCapacitySpendVerifier: await mockVerifier.getAddress(),
      CapacityVault: await capacityVault.getAddress(),
    },
    verifier: {
      circuitVersion,
      kind: "mock-dev-only",
    },
  };

  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
