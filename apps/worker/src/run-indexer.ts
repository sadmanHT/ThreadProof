import type { Address } from "viem";
import { createVerifiedPublicClient, startChainRuntimeWatch } from "./chain-runtime.js";
import { getIndexerEnv } from "./env.js";

const env = getIndexerEnv();
const contracts = [
  { label: "ThreadProofRegistry", address: env.THREADPROOF_REGISTRY_ADDRESS as Address },
  { label: "CredentialRegistry", address: env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS as Address },
  { label: "OrderRegistry", address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as Address },
  { label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address },
  { label: "SubcontractGovernor", address: env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS as Address },
  { label: "ThreadProofCharter", address: env.THREADPROOF_CHARTER_ADDRESS as Address },
] as const;
const { chainId } = await createVerifiedPublicClient(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
startChainRuntimeWatch(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
console.log(`Indexer runtime ready on chain ${chainId}; all configured protocol contracts contain bytecode`);
await import("./indexer.js");
