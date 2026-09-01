import type { Address } from "viem";
import { createVerifiedPublicClient, startChainRuntimeWatch } from "./chain-runtime.js";
import { getProofEnv } from "./env.js";
import { startWorkerRuntimeHeartbeat } from "./runtime-heartbeat.js";

const env = getProofEnv();
const contracts = [{ label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address }] as const;
const { chainId } = await createVerifiedPublicClient(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
await startWorkerRuntimeHeartbeat("capacity_release_generator", chainId);
startChainRuntimeWatch(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
console.log(`Capacity release generator runtime ready on chain ${chainId}; CapacityVault bytecode verified`);
await import("./capacity-release-generator.js");
