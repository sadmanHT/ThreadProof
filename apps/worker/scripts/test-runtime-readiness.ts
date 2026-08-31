import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { ChainRuntimeReadinessError, verifyChainRuntime } from "../src/chain-runtime.js";
import { getOrderRelayerEnv } from "../src/env.js";

const registry = "0x1111111111111111111111111111111111111111" as Address;
const vault = "0x2222222222222222222222222222222222222222" as Address;
const code = "0x6001600055" as Hex;

function fakeClient(options?: {
  chainId?: number;
  bytecode?: Partial<Record<Address, Hex | undefined>>;
  chainError?: Error;
}) {
  return {
    async getChainId() {
      if (options?.chainError) throw options.chainError;
      return options?.chainId ?? 2026;
    },
    async getBytecode({ address }: { address: Address }) {
      return options?.bytecode?.[address] ?? code;
    },
  };
}

async function rejectsWith(pattern: RegExp, task: () => Promise<unknown>) {
  await assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof ChainRuntimeReadinessError);
    assert.match(error.message, pattern);
    return true;
  });
}

await assert.doesNotReject(() => verifyChainRuntime(fakeClient(), 2026, [
  { label: "ThreadProofRegistry", address: registry },
  { label: "CapacityVault", address: vault },
]));

await rejectsWith(/does not match configured chain ID 2026/, () =>
  verifyChainRuntime(fakeClient({ chainId: 2027 }), 2026, [{ label: "ThreadProofRegistry", address: registry }]),
);

await rejectsWith(/has no deployed bytecode/, () =>
  verifyChainRuntime(
    fakeClient({ bytecode: { [vault]: "0x" } }),
    2026,
    [{ label: "CapacityVault", address: vault }],
  ),
);

await rejectsWith(/Canonical RPC is unreachable/, () =>
  verifyChainRuntime(fakeClient({ chainError: new Error("connection refused") }), 2026, []),
);

const envBase: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder-1234567890",
  THREADPROOF_RPC_URL: "https://rpc.internal.example",
  THREADPROOF_REGISTRY_ADDRESS: registry,
  THREADPROOF_ORDER_REGISTRY_ADDRESS: vault,
  THREADPROOF_DEPLOYMENT_ENV: "production",
  THREADPROOF_SIGNER_MODE: "remote",
  THREADPROOF_SIGNER_URL: "https://signer.internal.example",
  THREADPROOF_RELAYER_ADDRESS: registry,
};
for (const [key, value] of Object.entries(envBase)) process.env[key] = value;
delete process.env.THREADPROOF_CHAIN_ID;
delete process.env.THREADPROOF_RELAYER_PRIVATE_KEY;
delete process.env.THREADPROOF_WORKER_LEASE_SECONDS;
delete process.env.THREADPROOF_WORKER_HEARTBEAT_SECONDS;
assert.throws(() => getOrderRelayerEnv(), /must pin THREADPROOF_CHAIN_ID/i);

process.env.THREADPROOF_CHAIN_ID = "2026";
process.env.THREADPROOF_REGISTRY_ADDRESS = "0x0000000000000000000000000000000000000000";
assert.throws(() => getOrderRelayerEnv(), /Zero addresses are not valid/i);

process.env.THREADPROOF_REGISTRY_ADDRESS = registry;
process.env.THREADPROOF_WORKER_LEASE_SECONDS = "900";
process.env.THREADPROOF_WORKER_HEARTBEAT_SECONDS = "400";
assert.throws(() => getOrderRelayerEnv(), /at least three times/i);

process.env.THREADPROOF_WORKER_HEARTBEAT_SECONDS = "30";
const ready = getOrderRelayerEnv();
assert.equal(ready.THREADPROOF_WORKER_LEASE_SECONDS, 900);
assert.equal(ready.THREADPROOF_WORKER_HEARTBEAT_SECONDS, 30);

console.log("ThreadProof chain runtime readiness checks passed");
