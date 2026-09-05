import { writeFile } from "node:fs/promises";
import { ethers, network } from "hardhat";

const ORGANIZATIONS = {
  buyer: {
    id: `0x${"aa".repeat(32)}`,
    role: 1,
    keyEnv: "THREADPROOF_E2E_BUYER_PRIVATE_KEY",
  },
  factory: {
    id: `0x${"bb".repeat(32)}`,
    role: 2,
    keyEnv: "THREADPROOF_E2E_FACTORY_PRIVATE_KEY",
  },
  auditor: {
    id: `0x${"cc".repeat(32)}`,
    role: 3,
    keyEnv: "THREADPROOF_E2E_AUDITOR_PRIVATE_KEY",
  },
  regulator: {
    id: `0x${"dd".repeat(32)}`,
    role: 4,
    keyEnv: "THREADPROOF_E2E_REGULATOR_PRIVATE_KEY",
  },
} as const;

function requiredPrivateKey(name: string) {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a disposable test-only 32-byte private key`);
  }
  return value;
}

async function main() {
  const chainId = BigInt((await network.provider.send("eth_chainId")) as string);
  if (chainId !== 2026n) {
    throw new Error(`Browser-to-chain fixture must run on ThreadProof chain 2026; received ${chainId}`);
  }

  const provider = new ethers.BrowserProvider(network.provider as never);
  const admin = await provider.getSigner(0);
  const adminAddress = await admin.getAddress();

  const buyer = new ethers.Wallet(requiredPrivateKey(ORGANIZATIONS.buyer.keyEnv), provider);
  const factory = new ethers.Wallet(requiredPrivateKey(ORGANIZATIONS.factory.keyEnv), provider);
  const auditor = new ethers.Wallet(requiredPrivateKey(ORGANIZATIONS.auditor.keyEnv), provider);
  const regulator = new ethers.Wallet(requiredPrivateKey(ORGANIZATIONS.regulator.keyEnv), provider);
  const relayer = new ethers.Wallet(requiredPrivateKey("THREADPROOF_E2E_RELAYER_PRIVATE_KEY"), provider);

  const fixtureWallets = [buyer, factory, auditor, regulator, relayer];
  const addresses = fixtureWallets.map((wallet) => wallet.address.toLowerCase());
  if (new Set(addresses).size !== addresses.length) {
    throw new Error("Browser-to-chain fixture signer keys must resolve to distinct accounts");
  }

  for (const wallet of fixtureWallets) {
    const funding = await admin.sendTransaction({ to: wallet.address, value: ethers.parseEther("2") });
    await funding.wait();
  }

  const Registry = await ethers.getContractFactory("ThreadProofRegistry", admin);
  const registry = await Registry.deploy(adminAddress);
  await registry.waitForDeployment();

  await (await registry.registerOrganization(ORGANIZATIONS.buyer.id, buyer.address, ORGANIZATIONS.buyer.role, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(ORGANIZATIONS.factory.id, factory.address, ORGANIZATIONS.factory.role, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(ORGANIZATIONS.auditor.id, auditor.address, ORGANIZATIONS.auditor.role, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(ORGANIZATIONS.regulator.id, regulator.address, ORGANIZATIONS.regulator.role, ethers.ZeroHash)).wait();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry", admin);
  const credentials = await CredentialRegistry.deploy(adminAddress, await registry.getAddress());
  await credentials.waitForDeployment();
  await (await credentials.grantRole(await credentials.ISSUER_ROLE(), auditor.address)).wait();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry", admin);
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  // Stage 1 exercises real OrderRegistry authorization. Capacity proof verification is
  // deliberately still the explicit local mock here; Stage 2 replaces it with the
  // provenance-bound development Groth16 verifier before any PoFC browser assertion.
  const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier", admin);
  const mockVerifier = await MockVerifier.deploy();
  await mockVerifier.waitForDeployment();

  const CapacityVault = await ethers.getContractFactory("CapacityVault", admin);
  const capacityVault = await CapacityVault.deploy(
    adminAddress,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress(),
  );
  await capacityVault.waitForDeployment();
  await (await capacityVault.registerVerifier(1, await mockVerifier.getAddress())).wait();
  await (await capacityVault.grantRole(await capacityVault.CERTIFIER_ROLE(), auditor.address)).wait();

  const SubcontractGovernor = await ethers.getContractFactory("SubcontractGovernor", admin);
  const subcontractGovernor = await SubcontractGovernor.deploy(
    adminAddress,
    await registry.getAddress(),
    await credentials.getAddress(),
    await orders.getAddress(),
    await capacityVault.getAddress(),
  );
  await subcontractGovernor.waitForDeployment();

  const ThreadProofCharter = await ethers.getContractFactory("ThreadProofCharter", admin);
  const charter = await ThreadProofCharter.deploy(
    await registry.getAddress(),
    await credentials.getAddress(),
    await capacityVault.getAddress(),
    await subcontractGovernor.getAddress(),
  );
  await charter.waitForDeployment();
  const charterAddress = await charter.getAddress();

  // Match the reviewed local deployment shape: bootstrap authority is retired after
  // fixture organizations and narrowly scoped operational roles have been established.
  const defaultAdminRole = ethers.ZeroHash;
  await (await registry.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await registry.grantRole(await registry.SUSPENDER_ROLE(), charterAddress)).wait();
  await (await registry.grantRole(await registry.REGISTRAR_ROLE(), charterAddress)).wait();
  await (await registry.revokeRole(await registry.SUSPENDER_ROLE(), adminAddress)).wait();
  await (await registry.revokeRole(await registry.REGISTRAR_ROLE(), adminAddress)).wait();
  await (await registry.revokeRole(defaultAdminRole, adminAddress)).wait();

  await (await credentials.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await credentials.grantRole(await credentials.SUSPENDER_ROLE(), charterAddress)).wait();
  await (await credentials.revokeRole(await credentials.SUSPENDER_ROLE(), adminAddress)).wait();
  await (await credentials.revokeRole(defaultAdminRole, adminAddress)).wait();

  await (await capacityVault.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await capacityVault.grantRole(await capacityVault.VERIFIER_ADMIN_ROLE(), charterAddress)).wait();
  await (await capacityVault.grantRole(await capacityVault.PAUSER_ROLE(), charterAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.CERTIFIER_ROLE(), adminAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.VERIFIER_ADMIN_ROLE(), adminAddress)).wait();
  await (await capacityVault.revokeRole(await capacityVault.PAUSER_ROLE(), adminAddress)).wait();
  await (await capacityVault.revokeRole(defaultAdminRole, adminAddress)).wait();

  await (await subcontractGovernor.grantRole(defaultAdminRole, charterAddress)).wait();
  await (await subcontractGovernor.grantRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), charterAddress)).wait();
  await (await subcontractGovernor.grantRole(await subcontractGovernor.PAUSER_ROLE(), charterAddress)).wait();
  await (await subcontractGovernor.revokeRole(await subcontractGovernor.POLICY_ADMIN_ROLE(), adminAddress)).wait();
  await (await subcontractGovernor.revokeRole(await subcontractGovernor.PAUSER_ROLE(), adminAddress)).wait();
  await (await subcontractGovernor.revokeRole(defaultAdminRole, adminAddress)).wait();

  const deployment = {
    schemaVersion: 1,
    evidenceClass: "disposable-browser-integration",
    productionEvidence: false,
    chainId: chainId.toString(),
    organizations: {
      buyer: { id: ORGANIZATIONS.buyer.id, account: buyer.address },
      factory: { id: ORGANIZATIONS.factory.id, account: factory.address },
      auditor: { id: ORGANIZATIONS.auditor.id, account: auditor.address },
      regulator: { id: ORGANIZATIONS.regulator.id, account: regulator.address },
    },
    relayer: { account: relayer.address },
    contracts: {
      ThreadProofRegistry: await registry.getAddress(),
      CredentialRegistry: await credentials.getAddress(),
      OrderRegistry: await orders.getAddress(),
      CapacityVault: await capacityVault.getAddress(),
      SubcontractGovernor: await subcontractGovernor.getAddress(),
      ThreadProofCharter: charterAddress,
      MockCapacitySpendVerifier: await mockVerifier.getAddress(),
    },
    verifier: {
      circuitVersion: 1,
      kind: "mock-dev-only-stage1",
      stage2RequiresProvenanceBoundGroth16: true,
    },
    bootstrapAdminRetired: true,
  };

  const outputPath = process.env.THREADPROOF_BROWSER_E2E_OUTPUT_PATH?.trim();
  if (!outputPath) throw new Error("THREADPROOF_BROWSER_E2E_OUTPUT_PATH is required");
  await writeFile(outputPath, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  console.log(`THREADPROOF_BROWSER_E2E_DEPLOYMENT ${outputPath}`);
  console.log(`Buyer signer: ${buyer.address}`);
  console.log(`Factory signer: ${factory.address}`);
  console.log(`Auditor signer: ${auditor.address}`);
  console.log(`Regulator signer: ${regulator.address}`);
  console.log(`Relayer signer: ${relayer.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
