import type { Address } from "viem";
import { createVerifiedPublicClient } from "./chain-runtime.js";
import { getProofSubmitterEnv } from "./env.js";
import { createRelayerWallet } from "./signer.js";

const env = getProofSubmitterEnv();
const { chainId } = await createVerifiedPublicClient(
  env.THREADPROOF_RPC_URL,
  env.THREADPROOF_CHAIN_ID,
  [{ label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address }],
);
await createRelayerWallet(env, chainId);
console.log(`Proof submitter runtime ready on chain ${chainId}; signer handshake succeeded`);
await import("./proof-submitter.js");
