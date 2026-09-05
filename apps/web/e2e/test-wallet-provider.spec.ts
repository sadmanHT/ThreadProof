import { expect, test } from "@playwright/test";
import { recoverTypedDataAddress, type Hex } from "viem";
import { installDisposableTestWallet } from "./helpers/test-wallet";

const TEST_PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const CHAIN_ID = 2026;

const typedData = {
  domain: {
    name: "ThreadProof Browser E2E",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: "0x0000000000000000000000000000000000002026" as const,
  },
  types: {
    BrowserFixture: [
      { name: "purpose", type: "string" },
      { name: "revision", type: "uint256" },
    ],
  },
  primaryType: "BrowserFixture" as const,
  message: {
    purpose: "prove-test-wallet-stays-outside-browser",
    revision: 1n,
  },
};

test("disposable EIP-1193 wallet signs typed data through the Node-side test binding", async ({ page }) => {
  const expectedAddress = await installDisposableTestWallet(page, {
    privateKey: TEST_PRIVATE_KEY,
    chainId: CHAIN_ID,
  });

  await page.goto("/login");

  const walletState = await page.evaluate(async () => {
    const provider = (window as Window & {
      ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    }).ethereum;
    if (!provider) throw new Error("Test EIP-1193 provider was not installed.");

    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    const chainId = await provider.request({ method: "eth_chainId" }) as string;
    return { accounts, chainId };
  });

  expect(walletState.accounts).toEqual([expectedAddress]);
  expect(walletState.chainId).toBe("0x7ea");

  const signature = await page.evaluate(async ({ data, address }) => {
    const provider = (window as Window & {
      ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    }).ethereum;
    if (!provider) throw new Error("Test EIP-1193 provider was not installed.");

    const serialized = JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    return provider.request({
      method: "eth_signTypedData_v4",
      params: [address, serialized],
    }) as Promise<Hex>;
  }, { data: typedData, address: expectedAddress });

  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());
});

test("disposable EIP-1193 wallet refuses to sign for a different account", async ({ page }) => {
  await installDisposableTestWallet(page, {
    privateKey: TEST_PRIVATE_KEY,
    chainId: CHAIN_ID,
  });
  await page.goto("/login");

  const error = await page.evaluate(async (data) => {
    const provider = (window as Window & {
      ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    }).ethereum;
    if (!provider) throw new Error("Test EIP-1193 provider was not installed.");

    try {
      await provider.request({
        method: "eth_signTypedData_v4",
        params: [
          "0x0000000000000000000000000000000000000001",
          JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value),
        ],
      });
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }, typedData);

  expect(error).toContain("refused a signature for another account");
});

test("disposable EIP-1193 wallet never exposes raw signing and requires an explicit RPC for transactions", async ({ page }) => {
  const address = await installDisposableTestWallet(page, {
    privateKey: TEST_PRIVATE_KEY,
    chainId: CHAIN_ID,
  });
  await page.goto("/login");

  const errors = await page.evaluate(async (from) => {
    const provider = (window as Window & {
      ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
    }).ethereum;
    if (!provider) throw new Error("Test EIP-1193 provider was not installed.");

    async function rejected(method: string, params: unknown[]) {
      try {
        await provider!.request({ method, params });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    }

    return {
      raw: await rejected("eth_sendRawTransaction", ["0x00"]),
      sign: await rejected("eth_sign", [from, "0x00"]),
      sendWithoutRpc: await rejected("eth_sendTransaction", [{ from, to: from, value: "0x0" }]),
    };
  }, address);

  expect(errors.raw).toContain("refused browser RPC method eth_sendRawTransaction");
  expect(errors.sign).toContain("refused browser RPC method eth_sign");
  expect(errors.sendWithoutRpc).toContain("requires rpcUrl for eth_sendTransaction");
});
