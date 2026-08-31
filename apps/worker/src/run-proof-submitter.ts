import type { Address } from "viem";
import { createVerifiedPublicClient, startChainRuntimeWatch } from "./chain-runtime.js";
import { getProofSubmitterEnv } from "./env.js";
import { createRelayerWallet } from "./signer.js";

const env = getProofSubmitterEnv();
const contracts = [
  { label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address },
] as const;
const { chainId } = await createVerifiedPublicClient(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
await createRelayerWallet(env, chainId);
startChainRuntimeWatch(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
console.log(`Proof submitter runtime ready on chain ${chainId}; signer handshake succeeded`);
await import("./proof-submitter.js");
