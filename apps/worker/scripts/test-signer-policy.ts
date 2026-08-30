import assert from "node:assert/strict";
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

console.log("Production signer policy checks passed");
