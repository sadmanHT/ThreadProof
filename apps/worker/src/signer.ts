import {
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CommonEnv } from "./env.js";

type SignerEnv = Pick<
  CommonEnv,
  | "THREADPROOF_RPC_URL"
  | "THREADPROOF_DEPLOYMENT_ENV"
  | "THREADPROOF_SIGNER_MODE"
  | "THREADPROOF_SIGNER_URL"
  | "THREADPROOF_RELAYER_ADDRESS"
  | "THREADPROOF_RELAYER_PRIVATE_KEY"
>;

export class RelayerSignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerSignerUnavailableError";
  }
}

function chainFor(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: "ThreadProof Besu",
    nativeCurrency: { name: "ThreadProof Gas", symbol: "TPG", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export async function createRelayerWallet(env: SignerEnv, chainId: number) {
  const chain = chainFor(chainId, env.THREADPROOF_RPC_URL);

  if (env.THREADPROOF_SIGNER_MODE === "remote") {
    const signerUrl = env.THREADPROOF_SIGNER_URL;
    const account = env.THREADPROOF_RELAYER_ADDRESS as Address | undefined;
    if (!signerUrl || !account) {
      throw new RelayerSignerUnavailableError("Remote signer configuration is incomplete.");
    }

    const wallet = createWalletClient({
      account,
      chain,
      transport: http(signerUrl, { timeout: 8_000 }),
    });

    let addresses: readonly Address[];
    try {
      addresses = await wallet.getAddresses();
    } catch {
      throw new RelayerSignerUnavailableError("Remote signer is unreachable or rejected eth_accounts.");
    }

    if (!addresses.some((candidate) => candidate.toLowerCase() === account.toLowerCase())) {
      throw new RelayerSignerUnavailableError("Configured relayer address is not available from the remote signer.");
    }

    return { account, wallet, mode: "remote" as const };
  }

  if (env.THREADPROOF_SIGNER_MODE === "local-dev") {
    if (env.THREADPROOF_DEPLOYMENT_ENV !== "development") {
      throw new Error("Local private-key signing is disabled outside development.");
    }
    if (!env.THREADPROOF_RELAYER_PRIVATE_KEY) {
      throw new Error("Local development signer is missing THREADPROOF_RELAYER_PRIVATE_KEY.");
    }

    const account = privateKeyToAccount(env.THREADPROOF_RELAYER_PRIVATE_KEY as Hex);
    if (
      env.THREADPROOF_RELAYER_ADDRESS &&
      env.THREADPROOF_RELAYER_ADDRESS.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("Configured relayer address does not match the local development private key.");
    }

    const wallet = createWalletClient({
      account,
      chain,
      transport: http(env.THREADPROOF_RPC_URL, { timeout: 8_000 }),
    });
    return { account, wallet, mode: "local-dev" as const };
  }

  throw new RelayerSignerUnavailableError("Transaction signing is disabled for this worker.");
}
