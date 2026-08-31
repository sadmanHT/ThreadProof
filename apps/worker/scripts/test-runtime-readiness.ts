import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { ChainRuntimeReadinessError, verifyChainRuntime } from "../src/chain-runtime.js";

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

console.log("ThreadProof chain runtime readiness checks passed");
