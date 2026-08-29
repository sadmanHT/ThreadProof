import "server-only";
import { createPublicClient, http } from "viem";

export type BlockchainStatus = {
  configured: boolean;
  online: boolean;
  chainId: number | null;
  blockNumber: string | null;
  error: string | null;
};

export async function getBlockchainStatus(): Promise<BlockchainStatus> {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  if (!rpcUrl) {
    return { configured: false, online: false, chainId: null, blockNumber: null, error: null };
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000 }) });
    const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    return { configured: true, online: true, chainId, blockNumber: blockNumber.toString(), error: null };
  } catch (error) {
    return {
      configured: true,
      online: false,
      chainId: null,
      blockNumber: null,
      error: error instanceof Error ? error.message : "Unable to reach consortium chain",
    };
  }
}
