import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Address } from "viem";
import { createVerifiedPublicClient } from "../src/chain-runtime.js";
import {
  getIndexerEnv,
  getOrderRelayerEnv,
  getProofSubmitterEnv,
  getSubcontractRelayerEnv,
} from "../src/env.js";
import { createRelayerWallet } from "../src/signer.js";

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    throw new Error(`${label} must be a deployed 20-byte address`);
  }
  return value as Address;
}

const manifestPath = process.env.THREADPROOF_DEPLOYMENT_OUTPUT_PATH?.trim();
if (!manifestPath) throw new Error("THREADPROOF_DEPLOYMENT_OUTPUT_PATH is required for the pilot worker smoke");

const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
  chainId?: unknown;
  deployer?: unknown;
  contracts?: Record<string, unknown>;
};
const contracts = raw.contracts ?? {};
const chainId = Number(raw.chainId);
if (!Number.isSafeInteger(chainId) || chainId !== 2026) {
  throw new Error(`Pilot deployment manifest must target chain 2026; received ${String(raw.chainId)}`);
}

const deployer = asAddress(raw.deployer, "deployment.deployer");
const registry = asAddress(contracts.ThreadProofRegistry, "ThreadProofRegistry");
const credentials = asAddress(contracts.CredentialRegistry, "CredentialRegistry");
const orders = asAddress(contracts.OrderRegistry, "OrderRegistry");
const vault = asAddress(contracts.CapacityVault, "CapacityVault");
const subcontractGovernor = asAddress(contracts.SubcontractGovernor, "SubcontractGovernor");
const charter = asAddress(contracts.ThreadProofCharter, "ThreadProofCharter");

process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "pilot-worker-smoke-service-role-not-used";
process.env.THREADPROOF_RPC_URL ??= "http://127.0.0.1:8545";
process.env.THREADPROOF_CHAIN_ID = String(chainId);
process.env.THREADPROOF_DEPLOYMENT_ENV = "development";
process.env.THREADPROOF_SIGNER_MODE = "local-dev";
process.env.THREADPROOF_RELAYER_ADDRESS = deployer;
process.env.THREADPROOF_RELAYER_PRIVATE_KEY = process.env.DEV_DEPLOYER_PRIVATE_KEY;
process.env.THREADPROOF_REGISTRY_ADDRESS = registry;
process.env.THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS = credentials;
process.env.THREADPROOF_ORDER_REGISTRY_ADDRESS = orders;
process.env.THREADPROOF_CAPACITY_VAULT_ADDRESS = vault;
process.env.THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS = subcontractGovernor;
process.env.THREADPROOF_CHARTER_ADDRESS = charter;

if (!process.env.THREADPROOF_RELAYER_PRIVATE_KEY) {
  throw new Error("DEV_DEPLOYER_PRIVATE_KEY was not loaded from the disposable pilot environment");
}

// Parse the same schemas used by the long-running workers. This proves the generated pilot
// manifest is complete enough for every chain-writing/read-side worker except the proof
// generator, whose circuit-artifact/data-secret requirements are exercised in the PoFC slice.
const orderRelayerEnv = getOrderRelayerEnv();
getSubcontractRelayerEnv();
getProofSubmitterEnv();
getIndexerEnv();

const requiredContracts = [
  { label: "ThreadProofRegistry", address: registry },
  { label: "CredentialRegistry", address: credentials },
  { label: "OrderRegistry", address: orders },
  { label: "CapacityVault", address: vault },
  { label: "SubcontractGovernor", address: subcontractGovernor },
  { label: "ThreadProofCharter", address: charter },
] as const;

const { client, chainId: liveChainId } = await createVerifiedPublicClient(
  orderRelayerEnv.THREADPROOF_RPC_URL,
  orderRelayerEnv.THREADPROOF_CHAIN_ID,
  requiredContracts,
);
assert.equal(liveChainId, 2026);

const signer = await createRelayerWallet(orderRelayerEnv, liveChainId);
assert.equal(signer.mode, "local-dev");
assert.equal(signer.account.address.toLowerCase(), deployer.toLowerCase());

const balanceBefore = await client.getBalance({ address: signer.account.address });
assert.ok(balanceBefore > 0n, "Pilot relayer must be funded before worker transaction smoke");

// Submit a zero-value self transaction through the exact local-development wallet path used
// by transaction-writing workers. This proves signing, RPC submission, QBFT inclusion and
// receipt observation against the live five-validator network without mutating protocol state.
const hash = await signer.wallet.sendTransaction({
  to: signer.account.address,
  value: 0n,
});
const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
assert.equal(receipt.status, "success", "Worker-signed pilot transaction reverted");

console.log(
  `THREADPROOF_PILOT_WORKER_LIVE ${JSON.stringify({
    chainId: liveChainId,
    contractCount: requiredContracts.length,
    signerMode: signer.mode,
    transactionHash: hash,
    transactionBlock: receipt.blockNumber.toString(),
    workerSchemas: ["indexer", "order_relayer", "subcontract_relayer", "proof_submitter"],
  })}`,
);
