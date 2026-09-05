import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { ethers, network } from "hardhat";

const ZERO_A: [bigint, bigint] = [0n, 0n];
const ZERO_B: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const ZERO_C: [bigint, bigint] = [0n, 0n];

const ORDER_TYPES = {
  OrderVersion: [
    { name: "orderId", type: "bytes32" },
    { name: "buyerOrganizationId", type: "bytes32" },
    { name: "primaryFactoryOrganizationId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "previousVersionHash", type: "bytes32" },
    { name: "orderCommitment", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
};

async function main() {
  const provider = new ethers.BrowserProvider(network.provider as never);
  const [admin, buyerSigner, factorySigner, auditorSigner, relayer] = await Promise.all([
    provider.getSigner(0),
    provider.getSigner(1),
    provider.getSigner(2),
    provider.getSigner(3),
    provider.getSigner(4),
  ]);
  const adminAddress = await admin.getAddress();
  const buyerAddress = await buyerSigner.getAddress();
  const factoryAddress = await factorySigner.getAddress();
  const auditorAddress = await auditorSigner.getAddress();

  const Registry = await ethers.getContractFactory("ThreadProofRegistry", admin);
  const registry = await Registry.deploy(adminAddress);
  await registry.waitForDeployment();

  const buyerId = ethers.keccak256(ethers.toUtf8Bytes("benchmark-buyer"));
  const factoryId = ethers.keccak256(ethers.toUtf8Bytes("benchmark-factory"));
  const auditorId = ethers.keccak256(ethers.toUtf8Bytes("benchmark-auditor"));
  await (await registry.registerOrganization(buyerId, buyerAddress, 1, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(factoryId, factoryAddress, 2, ethers.ZeroHash)).wait();
  await (await registry.registerOrganization(auditorId, auditorAddress, 3, ethers.ZeroHash)).wait();

  const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry", admin);
  const credentials = await CredentialRegistry.deploy(adminAddress, await registry.getAddress());
  await credentials.waitForDeployment();
  await (await credentials.grantRole(await credentials.ISSUER_ROLE(), auditorAddress)).wait();

  const OrderRegistry = await ethers.getContractFactory("OrderRegistry", admin);
  const orders = await OrderRegistry.deploy(await registry.getAddress());
  await orders.waitForDeployment();

  const MockVerifier = await ethers.getContractFactory("MockCapacitySpendVerifier", admin);
  const verifier = await MockVerifier.deploy();
  await verifier.waitForDeployment();

  const Vault = await ethers.getContractFactory("CapacityVault", admin);
  const vault = await Vault.deploy(
    adminAddress,
    await credentials.getAddress(),
    await orders.getAddress(),
    await registry.getAddress(),
  );
  await vault.waitForDeployment();
  await (await vault.registerVerifier(1, await verifier.getAddress())).wait();
  await (await vault.grantRole(await vault.CERTIFIER_ROLE(), auditorAddress)).wait();

  const networkInfo = await provider.getNetwork();
  const chainId = networkInfo.chainId;
  const processId = ethers.keccak256(ethers.toUtf8Bytes("SEWING"));
  const policyHash = ethers.keccak256(ethers.toUtf8Bytes("benchmark-policy-v1"));
  const orderDomain = {
    name: "ThreadProof OrderRegistry",
    version: "1",
    chainId,
    verifyingContract: await orders.getAddress(),
  };

  async function certify(periodId: string, initialCommitment: bigint, label: string) {
    const credentialId = ethers.keccak256(ethers.toUtf8Bytes(`benchmark-credential-${label}`));
    const scopeHash = await vault.capacityCredentialScopeHash(
      factoryId,
      periodId,
      processId,
      policyHash,
      initialCommitment,
    );
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("Benchmark provider returned no latest block");
    const now = BigInt(latest.timestamp);
    await (
      await credentials.connect(auditorSigner).issueCredential(
        credentialId,
        factoryId,
        await vault.CAPACITY_CREDENTIAL_TYPE(),
        ethers.keccak256(ethers.toUtf8Bytes(`benchmark-credential-body-${label}`)),
        scopeHash,
        now - 60n,
        now + 86_400n,
      )
    ).wait();
    await (
      await vault.connect(auditorSigner).certifyCapacity(
        factoryId,
        periodId,
        processId,
        initialCommitment,
        credentialId,
        policyHash,
        1,
      )
    ).wait();
  }

  async function authorizeOrder(orderId: string, orderCommitment: bigint) {
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("Benchmark provider returned no latest block");
    const authorization = {
      orderId,
      buyerOrganizationId: buyerId,
      primaryFactoryOrganizationId: factoryId,
      version: 1,
      previousVersionHash: ethers.ZeroHash,
      orderCommitment,
      policyHash,
      nonce: await orders.nonces(buyerId),
      deadline: BigInt(latest.timestamp) + 3_600n,
    };
    const signature = await buyerSigner.signTypedData(orderDomain, ORDER_TYPES, authorization);
    await (await orders.connect(relayer).submitOrderVersion(authorization, signature)).wait();
  }

  const independentCount = 6;
  const independentSpends: Array<{
    factoryOrganizationId: string;
    periodId: string;
    processId: string;
    orderId: string;
    policyHash: string;
    oldCapacityCommitment: bigint;
    newCapacityCommitment: bigint;
    orderCommitment: bigint;
    nullifier: bigint;
    circuitVersion: number;
  }> = [];

  for (let index = 0; index < independentCount; index += 1) {
    const periodId = ethers.keccak256(ethers.toUtf8Bytes(`BENCH-INDEPENDENT-${index}`));
    const oldCapacityCommitment = 10_000n + BigInt(index);
    const newCapacityCommitment = 20_000n + BigInt(index);
    const orderCommitment = 30_000n + BigInt(index);
    const nullifier = 40_000n + BigInt(index);
    const orderId = ethers.keccak256(ethers.toUtf8Bytes(`benchmark-independent-order-${index}`));
    await certify(periodId, oldCapacityCommitment, `independent-${index}`);
    await authorizeOrder(orderId, orderCommitment);
    independentSpends.push({
      factoryOrganizationId: factoryId,
      periodId,
      processId,
      orderId,
      policyHash,
      oldCapacityCommitment,
      newCapacityCommitment,
      orderCommitment,
      nullifier,
      circuitVersion: 1,
    });
  }

  let independentReceipts: Array<Awaited<ReturnType<typeof provider.getTransactionReceipt>>> = [];
  const independentStarted = performance.now();
  await network.provider.send("evm_setAutomine", [false]);
  try {
    const firstNonce = await factorySigner.getNonce("pending");
    const transactions = [];
    for (let index = 0; index < independentSpends.length; index += 1) {
      transactions.push(
        await vault
          .connect(factorySigner)
          .spendCapacity(independentSpends[index], ZERO_A, ZERO_B, ZERO_C, {
            gasLimit: 1_500_000,
            nonce: firstNonce + index,
          }),
      );
    }
    await network.provider.send("evm_mine");
    independentReceipts = await Promise.all(
      transactions.map((transaction) => provider.getTransactionReceipt(transaction.hash)),
    );
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const independentElapsedMs = Math.round((performance.now() - independentStarted) * 100) / 100;
  assert.equal(independentReceipts.length, independentCount);
  assert.ok(independentReceipts.every((receipt) => receipt?.status === 1), "Independent-key benchmark did not finalize every spend");
  const independentBlocks = independentReceipts.map((receipt) => receipt!.blockNumber);
  const independentThroughputPerSecond = Math.round((independentCount / (independentElapsedMs / 1_000)) * 100) / 100;

  const racePeriodId = ethers.keccak256(ethers.toUtf8Bytes("BENCH-SAME-STATE-RACE"));
  const raceOldCommitment = 90_001n;
  await certify(racePeriodId, raceOldCommitment, "same-state-race");
  const raceOrderA = ethers.keccak256(ethers.toUtf8Bytes("benchmark-race-order-a"));
  const raceOrderB = ethers.keccak256(ethers.toUtf8Bytes("benchmark-race-order-b"));
  await authorizeOrder(raceOrderA, 91_001n);
  await authorizeOrder(raceOrderB, 91_002n);
  const raceSpendA = {
    factoryOrganizationId: factoryId,
    periodId: racePeriodId,
    processId,
    orderId: raceOrderA,
    policyHash,
    oldCapacityCommitment: raceOldCommitment,
    newCapacityCommitment: 92_001n,
    orderCommitment: 91_001n,
    nullifier: 93_001n,
    circuitVersion: 1,
  };
  const raceSpendB = {
    ...raceSpendA,
    orderId: raceOrderB,
    newCapacityCommitment: 92_002n,
    orderCommitment: 91_002n,
    nullifier: 93_002n,
  };

  const raceStarted = performance.now();
  let raceReceipts: Array<Awaited<ReturnType<typeof provider.getTransactionReceipt>>> = [];
  await network.provider.send("evm_setAutomine", [false]);
  try {
    const firstNonce = await factorySigner.getNonce("pending");
    const txA = await vault
      .connect(factorySigner)
      .spendCapacity(raceSpendA, ZERO_A, ZERO_B, ZERO_C, {
        gasLimit: 1_500_000,
        nonce: firstNonce,
      });
    const txB = await vault
      .connect(factorySigner)
      .spendCapacity(raceSpendB, ZERO_A, ZERO_B, ZERO_C, {
        gasLimit: 1_500_000,
        nonce: firstNonce + 1,
      });
    await network.provider.send("evm_mine");
    raceReceipts = await Promise.all([
      provider.getTransactionReceipt(txA.hash),
      provider.getTransactionReceipt(txB.hash),
    ]);
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const raceElapsedMs = Math.round((performance.now() - raceStarted) * 100) / 100;
  const raceStatuses = raceReceipts.map((receipt) => receipt?.status ?? null);
  assert.deepEqual([...raceStatuses].sort(), [0, 1], "Same-state race must finalize exactly one transaction");
  const raceState = await vault.getCapacityState(factoryId, racePeriodId, processId);
  assert.ok(
    raceState.activeCommitment === raceSpendA.newCapacityCommitment ||
      raceState.activeCommitment === raceSpendB.newCapacityCommitment,
    "Same-state race finalized an unexpected successor commitment",
  );
  const usedNullifiers =
    Number(await vault.usedNullifiers(raceSpendA.nullifier)) +
    Number(await vault.usedNullifiers(raceSpendB.nullifier));
  assert.equal(usedNullifiers, 1, "Same-state race must consume exactly one nullifier");

  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(process.cwd(), "../.."),
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  const benchmark = {
    schemaVersion: 1,
    format: "threadproof-capacity-concurrency-benchmark/v1",
    sourceCommit,
    network: "hardhat-in-process",
    chainId: chainId.toString(),
    verifier: "MockCapacitySpendVerifier",
    cryptographicVerificationIncluded: false,
    independentKeys: {
      transactionCount: independentCount,
      elapsedMs: independentElapsedMs,
      transactionsPerSecond: independentThroughputPerSecond,
      firstBlock: Math.min(...independentBlocks),
      lastBlock: Math.max(...independentBlocks),
      allFinalized: true,
    },
    sameStateRace: {
      submitted: 2,
      finalized: raceStatuses.filter((status) => status === 1).length,
      reverted: raceStatuses.filter((status) => status === 0).length,
      elapsedMs: raceElapsedMs,
      exactlyOneFinalized: true,
      exactlyOneNullifierConsumed: usedNullifiers === 1,
    },
    note:
      "This benchmark isolates CapacityVault canonical-state serialization from Groth16 cost by using the explicitly labeled mock verifier on the in-process Hardhat network. Real Groth16 verifier gas and five-validator QBFT confirmation are measured separately and must not be conflated with this throughput result.",
  };

  const artifactDir = path.resolve(process.cwd(), "../../artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, "capacity-concurrency-benchmark.json"),
    `${JSON.stringify(benchmark, null, 2)}\n`,
  );
  console.log(`THREADPROOF_CAPACITY_CONCURRENCY ${JSON.stringify(benchmark)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
