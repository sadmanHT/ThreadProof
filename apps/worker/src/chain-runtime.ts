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
