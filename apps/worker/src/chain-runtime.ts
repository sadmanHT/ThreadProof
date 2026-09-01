import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";

export type RequiredContract = {
  label: string;
  address: Address;
};

type RuntimeClient = {
  getChainId: () => Promise<number>;
  getBytecode: (args: { address: Address }) => Promise<Hex | undefined>;
};

export class ChainRuntimeReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainRuntimeReadinessError";
  }
}

export class CanonicalBlockProgressMonitor {
  private lastBlockNumber: bigint | undefined;
  private lastProgressAtMs: number | undefined;

  constructor(readonly stallThresholdMs: number) {
    if (!Number.isSafeInteger(stallThresholdMs) || stallThresholdMs <= 0) {
      throw new ChainRuntimeReadinessError("Canonical block stall threshold must be a positive integer number of milliseconds.");
    }
  }

  observe(blockNumber: bigint, observedAtMs = Date.now()) {
    if (blockNumber < 0n) {
      throw new ChainRuntimeReadinessError(`Canonical RPC returned invalid block number ${blockNumber}.`);
    }
    if (!Number.isFinite(observedAtMs) || observedAtMs < 0) {
      throw new ChainRuntimeReadinessError("Canonical block observation time is invalid.");
    }

    if (this.lastBlockNumber === undefined) {
      this.lastBlockNumber = blockNumber;
      this.lastProgressAtMs = observedAtMs;
      return;
    }

    if (blockNumber < this.lastBlockNumber) {
      throw new ChainRuntimeReadinessError(
        `Canonical block height moved backwards from ${this.lastBlockNumber} to ${blockNumber}.`,
      );
    }

    if (blockNumber > this.lastBlockNumber) {
      this.lastBlockNumber = blockNumber;
      this.lastProgressAtMs = observedAtMs;
      return;
    }

    const lastProgressAtMs = this.lastProgressAtMs ?? observedAtMs;
    const stalledForMs = observedAtMs - lastProgressAtMs;
    if (stalledForMs >= this.stallThresholdMs) {
      throw new ChainRuntimeReadinessError(
        `Canonical chain has not advanced beyond block ${blockNumber} for ${stalledForMs}ms; refusing to treat a responsive RPC as healthy.`,
      );
    }
  }
}

function detail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyChainRuntime(
  client: RuntimeClient,
  expectedChainId: number | undefined,
  contracts: readonly RequiredContract[],
) {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new ChainRuntimeReadinessError(`Canonical RPC is unreachable: ${detail(error)}`);
  }

  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new ChainRuntimeReadinessError(`Canonical RPC returned invalid chain ID ${chainId}.`);
  }
  if (expectedChainId !== undefined && expectedChainId !== chainId) {
    throw new ChainRuntimeReadinessError(
      `Canonical RPC chain ID ${chainId} does not match configured chain ID ${expectedChainId}.`,
    );
  }

  for (const contract of contracts) {
    let bytecode: Hex | undefined;
    try {
      bytecode = await client.getBytecode({ address: contract.address });
    } catch (error) {
      throw new ChainRuntimeReadinessError(
        `Could not verify ${contract.label} bytecode at ${contract.address}: ${detail(error)}`,
      );
    }
    if (!bytecode || bytecode === "0x") {
      throw new ChainRuntimeReadinessError(
        `Required ${contract.label} contract has no deployed bytecode at ${contract.address}.`,
      );
    }
  }

  return chainId;
}

export async function createVerifiedPublicClient(
  rpcUrl: string,
  expectedChainId: number | undefined,
  contracts: readonly RequiredContract[],
) {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 8_000, retryCount: 2, retryDelay: 250 }),
  });
  const chainId = await verifyChainRuntime(client, expectedChainId, contracts);
  return { client, chainId };
}

export function startChainRuntimeWatch(
  rpcUrl: string,
  expectedChainId: number | undefined,
  contracts: readonly RequiredContract[],
  intervalMs = 30_000,
  stallThresholdMs = Math.max(90_000, intervalMs * 3),
) {
  const progress = new CanonicalBlockProgressMonitor(stallThresholdMs);
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const { client } = await createVerifiedPublicClient(rpcUrl, expectedChainId, contracts);
      const blockNumber = await client.getBlockNumber();
      progress.observe(blockNumber);
    } catch (error) {
      console.error(`ThreadProof chain runtime readiness was lost: ${detail(error)}`);
      process.exit(1);
    } finally {
      checking = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
