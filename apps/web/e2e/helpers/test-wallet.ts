import type { Page } from "@playwright/test";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type DisposableTestWallet = {
  privateKey: Hex;
  chainId: number;
};

type JsonRpcRequest = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

/**
 * Installs a minimal EIP-1193 provider for browser-to-chain integration tests.
 *
 * The private key never enters the browser context. `eth_signTypedData_v4` is
 * forwarded through a Playwright binding to a Node-side disposable test account,
 * while the application still executes its normal wallet, chain-ID, EIP-712 and
 * on-chain organization-mapping checks.
 */
export async function installDisposableTestWallet(page: Page, fixture: DisposableTestWallet) {
  const account = privateKeyToAccount(fixture.privateKey);
  const bindingName = `__threadproofSignTypedData_${account.address.slice(2, 10)}`;

  await page.exposeFunction(bindingName, async (serializedTypedData: string) => {
    const typedData = JSON.parse(serializedTypedData) as Parameters<typeof account.signTypedData>[0];
    return account.signTypedData(typedData);
  });

  await page.addInitScript(
    ({ address, chainId, signBinding }) => {
      const browser = window as typeof window & {
        ethereum?: {
          request(args: JsonRpcRequest): Promise<unknown>;
          on?(): void;
          removeListener?(): void;
        };
      };

      browser.ethereum = {
        async request({ method, params }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [address];
          }
          if (method === "eth_chainId") {
            return `0x${chainId.toString(16)}`;
          }
          if (method === "eth_signTypedData_v4") {
            const values = Array.isArray(params) ? params : [];
            const requestedAccount = String(values[0] ?? "").toLowerCase();
            if (requestedAccount !== address.toLowerCase()) {
              throw new Error("Disposable test wallet refused a signature for another account.");
            }
            const serialized = values[1];
            if (typeof serialized !== "string") {
              throw new Error("Disposable test wallet expected serialized EIP-712 typed data.");
            }
            const signer = (browser as unknown as Record<string, unknown>)[signBinding];
            if (typeof signer !== "function") {
              throw new Error("Disposable test-wallet signing binding is unavailable.");
            }
            return (signer as (payload: string) => Promise<string>)(serialized);
          }
          throw new Error(`Disposable test wallet does not implement ${method}.`);
        },
        on() {},
        removeListener() {},
      };
    },
    { address: account.address, chainId: fixture.chainId, signBinding: bindingName },
  );

  return account.address;
}
