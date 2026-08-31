import type { Address } from "viem";
import { createVerifiedPublicClient } from "./chain-runtime.js";
import { getProofEnv } from "./env.js";

const env = getProofEnv();
const { chainId } = await createVerifiedPublicClient(
  env.THREADPROOF_RPC_URL,
  env.THREADPROOF_CHAIN_ID,
  [{ label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address }],
);
console.log(`Proof generator runtime ready on chain ${chainId}; CapacityVault bytecode verified`);
await import("./proof-generator.js");
