import type { Address } from "viem";
import { createVerifiedPublicClient, startChainRuntimeWatch } from "./chain-runtime.js";
import { getOrderRelayerEnv } from "./env.js";
import { startWorkerRuntimeHeartbeat } from "./runtime-heartbeat.js";
import { createRelayerWallet } from "./signer.js";

const env = getOrderRelayerEnv();
const contracts = [
  { label: "ThreadProofRegistry", address: env.THREADPROOF_REGISTRY_ADDRESS as Address },
  { label: "OrderRegistry", address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as Address },
] as const;
const { chainId } = await createVerifiedPublicClient(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
await createRelayerWallet(env, chainId);
await startWorkerRuntimeHeartbeat("order_relayer", chainId);
startChainRuntimeWatch(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
console.log(`Order relayer runtime ready on chain ${chainId}; signer handshake succeeded`);
await import("./order-relayer.js");
