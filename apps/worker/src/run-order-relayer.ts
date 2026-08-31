import type { Address } from "viem";
import { createVerifiedPublicClient } from "./chain-runtime.js";
import { getOrderRelayerEnv } from "./env.js";
import { createRelayerWallet } from "./signer.js";

const env = getOrderRelayerEnv();
const { chainId } = await createVerifiedPublicClient(
  env.THREADPROOF_RPC_URL,
  env.THREADPROOF_CHAIN_ID,
  [
    { label: "ThreadProofRegistry", address: env.THREADPROOF_REGISTRY_ADDRESS as Address },
    { label: "OrderRegistry", address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as Address },
  ],
);
await createRelayerWallet(env, chainId);
console.log(`Order relayer runtime ready on chain ${chainId}; signer handshake succeeded`);
await import("./order-relayer.js");
