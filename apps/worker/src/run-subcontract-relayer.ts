import type { Address } from "viem";
import { createVerifiedPublicClient, startChainRuntimeWatch } from "./chain-runtime.js";
import { getSubcontractRelayerEnv } from "./env.js";
import { startWorkerRuntimeHeartbeat } from "./runtime-heartbeat.js";
import { createRelayerWallet } from "./signer.js";

const env = getSubcontractRelayerEnv();
const contracts = [
  { label: "ThreadProofRegistry", address: env.THREADPROOF_REGISTRY_ADDRESS as Address },
  { label: "CredentialRegistry", address: env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS as Address },
  { label: "OrderRegistry", address: env.THREADPROOF_ORDER_REGISTRY_ADDRESS as Address },
  { label: "CapacityVault", address: env.THREADPROOF_CAPACITY_VAULT_ADDRESS as Address },
  { label: "SubcontractGovernor", address: env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS as Address },
] as const;

const { chainId } = await createVerifiedPublicClient(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
await createRelayerWallet(env, chainId);
await startWorkerRuntimeHeartbeat("subcontract_relayer", chainId);
startChainRuntimeWatch(env.THREADPROOF_RPC_URL, env.THREADPROOF_CHAIN_ID, contracts);
console.log(`Subcontract relayer runtime ready on chain ${chainId}; signer handshake succeeded`);
await import("./subcontract-relayer.js");
