import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getOrderRelayerEnv, getProofEnv, getProofSubmitterEnv } from "../src/env.js";

const ADDRESS = `0x${"11".repeat(20)}`;
const PRIVATE_KEY = `0x${"22".repeat(32)}`;
const BASE: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder-1234567890",
  THREADPROOF_RPC_URL: "http://127.0.0.1:8545",
  THREADPROOF_CHAIN_ID: "2026",
  THREADPROOF_REGISTRY_ADDRESS: ADDRESS,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: ADDRESS,
  THREADPROOF_CAPACITY_VAULT_ADDRESS: ADDRESS,
  THREADPROOF_CAPACITY_WASM_PATH: "/tmp/CapacitySpend.wasm",
  THREADPROOF_CAPACITY_ZKEY_PATH: "/tmp/CapacitySpend.zkey",
  THREADPROOF_DATA_KEY_BASE64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  THREADPROOF_FACTORY_SECRETS_JSON: "{}",
};

const signerKeys = [
  "THREADPROOF_DEPLOYMENT_ENV",
  "THREADPROOF_SIGNER_MODE",
  "THREADPROOF_SIGNER_URL",
  "THREADPROOF_RELAYER_ADDRESS",
  "THREADPROOF_RELAYER_PRIVATE_KEY",
] as const;

function configure(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(BASE)) process.env[key] = value;
  for (const key of signerKeys) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

configure({
  THREADPROOF_DEPLOYMENT_ENV: "production",
  THREADPROOF_SIGNER_MODE: "remote",
  THREADPROOF_SIGNER_URL: "https://signer.internal.example",
  THREADPROOF_RELAYER_ADDRESS: ADDRESS,
});
assert.equal(getOrderRelayerEnv().THREADPROOF_SIGNER_MODE, "remote");
assert.equal(getProofSubmitterEnv().THREADPROOF_SIGNER_MODE, "remote");
assert.throws(() => getProofEnv(), /proof generator must have transaction signing disabled/i);

configure({
  THREADPROOF_DEPLOYMENT_ENV: "production",
  THREADPROOF_SIGNER_MODE: "local-dev",
  THREADPROOF_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
});
assert.throws(() => getOrderRelayerEnv(), /development-only|Production workers/);

configure({
  THREADPROOF_DEPLOYMENT_ENV: "production",
  THREADPROOF_SIGNER_MODE: "remote",
  THREADPROOF_SIGNER_URL: "https://signer.internal.example",
  THREADPROOF_RELAYER_ADDRESS: ADDRESS,
  THREADPROOF_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
});
assert.throws(() => getOrderRelayerEnv(), /forbids an in-process|never receive/);

configure({ THREADPROOF_SIGNER_MODE: "disabled" });
assert.throws(() => getOrderRelayerEnv(), /transaction signer is required/);
assert.throws(() => getProofSubmitterEnv(), /transaction signer is required/);
assert.equal(getProofEnv().THREADPROOF_SIGNER_MODE, "disabled");

configure({
  THREADPROOF_DEPLOYMENT_ENV: "development",
  THREADPROOF_SIGNER_MODE: "local-dev",
  THREADPROOF_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
  THREADPROOF_RELAYER_ADDRESS: ADDRESS,
});
assert.equal(getOrderRelayerEnv().THREADPROOF_SIGNER_MODE, "local-dev");
assert.throws(() => getProofEnv(), /proof generator must have transaction signing disabled/i);

const proofGeneratorSource = readFileSync(new URL("../src/proof-generator.ts", import.meta.url), "utf8");
for (const forbidden of [
  "privateKeyToAccount",
  "THREADPROOF_RELAYER_PRIVATE_KEY",
  "createWalletClient",
  "createRelayerWallet",
  "capacityVaultAbi",
  ".writeContract(",
]) {
  assert.equal(
    proofGeneratorSource.includes(forbidden),
    false,
    `Proof generator must not contain transaction-signing primitive: ${forbidden}`,
  );
}

const signerSource = readFileSync(new URL("../src/signer.ts", import.meta.url), "utf8");
for (const required of ["eth_chainId", "getAddresses", "Remote signer downstream chain ID"]) {
  assert.ok(signerSource.includes(required), `Remote signer must enforce ${required}`);
}

const proofSubmitterSource = readFileSync(new URL("../src/proof-submitter.ts", import.meta.url), "utf8");
for (const forbidden of [
  "private_capacity_openings",
  "capacity_allocations",
  "proof_job_private_state",
  "next_capacity_ciphertext",
  "next_randomness_ciphertext",
]) {
  assert.equal(
    proofSubmitterSource.includes(forbidden),
    false,
    `Proof submitter must not finalize private mirror state directly: ${forbidden}`,
  );
}
assert.ok(
  proofSubmitterSource.includes("waiting for canonical event indexing"),
  "Proof submitter must leave successful private-state reconciliation to the canonical event indexer",
);

console.log("Production signer, proof-process, and event-recovery boundary checks passed");
