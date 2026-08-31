import "server-only";
import { createPublicClient, http } from "viem";

export type BlockchainStatus = {
  configured: boolean;
  online: boolean;
  chainId: number | null;
  expectedChainId: number | null;
  blockNumber: string | null;
  error: string | null;
};

function configuredChainId() {
  const raw = process.env.THREADPROOF_CHAIN_ID;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

export async function getBlockchainStatus(): Promise<BlockchainStatus> {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const expectedChainId = configuredChainId();
  if (!rpcUrl) {
    return { configured: false, online: false, chainId: null, expectedChainId: null, blockNumber: null, error: null };
  }
  if (Number.isNaN(expectedChainId)) {
    return {
      configured: true,
      online: false,
      chainId: null,
      expectedChainId: null,
      blockNumber: null,
      error: "Configured consortium chain ID is invalid",
    };
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
    const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    if (expectedChainId !== null && chainId !== expectedChainId) {
      return {
        configured: true,
        online: false,
        chainId,
        expectedChainId,
        blockNumber: blockNumber.toString(),
        error: "Connected RPC is serving the wrong consortium chain",
      };
    }
    return {
      configured: true,
      online: true,
      chainId,
      expectedChainId,
      blockNumber: blockNumber.toString(),
      error: null,
    };
  } catch {
    return {
      configured: true,
      online: false,
      chainId: null,
      expectedChainId: expectedChainId === null ? null : expectedChainId,
      blockNumber: null,
      error: "Unable to reach consortium chain",
    };
  }
}
