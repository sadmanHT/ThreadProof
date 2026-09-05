import type { Page } from "@playwright/test";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type DisposableTestWallet = {
  privateKey: Hex;
  chainId: number;
  rpcUrl?: string;
};

type JsonRpcRequest = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

type JsonRpcTransaction = Record<string, unknown>;

const FORBIDDEN_PROXY_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sign",
  "eth_signTransaction",
  "personal_sign",
  "personal_sendTransaction",
  "wallet_addEthereumChain",
  "wallet_switchEthereumChain",
]);

function optionalHexQuantity(value: unknown, label: string): bigint | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be a JSON-RPC hex quantity`);
  }
  return BigInt(value);
}

function optionalNonce(value: unknown): number | undefined {
  const parsed = optionalHexQuantity(value, "transaction.nonce");
  if (parsed == null) return undefined;
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("transaction.nonce exceeds JavaScript safe integer range");
  }
  return Number(parsed);
}

/**
 * Installs a minimal EIP-1193 provider for browser-to-chain integration tests.
 *
 * The private key never enters the browser context. Typed-data signatures and
 * transaction signatures are executed through Node-side Playwright bindings.
 * Read-only JSON-RPC methods may be proxied to the disposable Besu endpoint when
 * rpcUrl is supplied. Raw signing/export methods remain unavailable to browser code.
 */
export async function installDisposableTestWallet(page: Page, fixture: DisposableTestWallet) {
  const account = privateKeyToAccount(fixture.privateKey);
  const suffix = account.address.slice(2, 10);
  const signBindingName = `__threadproofSignTypedData_${suffix}`;
  const sendBindingName = `__threadproofSendTransaction_${suffix}`;
  const rpcBindingName = `__threadproofRpc_${suffix}`;
  const wallet = fixture.rpcUrl
    ? createWalletClient({ account, transport: http(fixture.rpcUrl, { timeout: 8_000 }) })
    : null;

  await page.exposeFunction(signBindingName, async (serializedTypedData: string) => {
    const typedData = JSON.parse(serializedTypedData) as Parameters<typeof account.signTypedData>[0];
    return account.signTypedData(typedData);
  });

  if (fixture.rpcUrl && wallet) {
    const rpcUrl = fixture.rpcUrl;
    await page.exposeFunction(rpcBindingName, async (method: string, params: unknown) => {
      if (FORBIDDEN_PROXY_METHODS.has(method) || method.startsWith("personal_") || method.startsWith("wallet_")) {
        throw new Error(`Disposable test wallet refused browser RPC method ${method}.`);
      }
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`Disposable RPC ${method} returned HTTP ${response.status}.`);
      const body = await response.json() as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      if (body.error) {
        throw new Error(`Disposable RPC ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
      }
      return body.result;
    });

    await page.exposeFunction(sendBindingName, async (serializedTransaction: string) => {
      const transaction = JSON.parse(serializedTransaction) as JsonRpcTransaction;
      const from = String(transaction.from ?? "").toLowerCase();
      if (from !== account.address.toLowerCase()) {
        throw new Error("Disposable test wallet refused a transaction for another account.");
      }
      const to = transaction.to;
      if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        throw new Error("Disposable browser-chain transactions must target a deployed contract/account.");
      }
      const data = transaction.data;
      if (data != null && (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data))) {
        throw new Error("transaction.data must be hex calldata");
      }

      const request: Record<string, unknown> = {
        account,
        to: to as Address,
      };
      if (typeof data === "string") request.data = data as Hex;
      const value = optionalHexQuantity(transaction.value, "transaction.value");
      const gas = optionalHexQuantity(transaction.gas, "transaction.gas");
      const gasPrice = optionalHexQuantity(transaction.gasPrice, "transaction.gasPrice");
      const maxFeePerGas = optionalHexQuantity(transaction.maxFeePerGas, "transaction.maxFeePerGas");
      const maxPriorityFeePerGas = optionalHexQuantity(transaction.maxPriorityFeePerGas, "transaction.maxPriorityFeePerGas");
      const nonce = optionalNonce(transaction.nonce);
      if (value != null) request.value = value;
      if (gas != null) request.gas = gas;
      if (gasPrice != null) request.gasPrice = gasPrice;
      if (maxFeePerGas != null) request.maxFeePerGas = maxFeePerGas;
      if (maxPriorityFeePerGas != null) request.maxPriorityFeePerGas = maxPriorityFeePerGas;
      if (nonce != null) request.nonce = nonce;

      return wallet.sendTransaction(request as Parameters<typeof wallet.sendTransaction>[0]);
    });
  }

  await page.addInitScript(
    ({ address, chainId, signBinding, sendBinding, rpcBinding, hasRpc }) => {
      const browser = window as typeof window & {
        ethereum?: {
          request(args: JsonRpcRequest): Promise<unknown>;
          on?(): void;
          removeListener?(): void;
        };
      };

      const binding = (name: string) => (browser as unknown as Record<string, unknown>)[name];
      browser.ethereum = {
        async request({ method, params }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
          if (method === "eth_chainId") return `0x${chainId.toString(16)}`;

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
            const signer = binding(signBinding);
            if (typeof signer !== "function") throw new Error("Disposable test-wallet signing binding is unavailable.");
            return (signer as (payload: string) => Promise<string>)(serialized);
          }

          if (method === "eth_sendTransaction") {
            const values = Array.isArray(params) ? params : [];
            const transaction = values[0];
            if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
              throw new Error("Disposable test wallet expected one JSON-RPC transaction object.");
            }
            const from = String((transaction as Record<string, unknown>).from ?? "").toLowerCase();
            if (from !== address.toLowerCase()) {
              throw new Error("Disposable test wallet refused a transaction for another account.");
            }
            if (!hasRpc) throw new Error("Disposable test wallet requires rpcUrl for eth_sendTransaction.");
            const sender = binding(sendBinding);
            if (typeof sender !== "function") throw new Error("Disposable test-wallet transaction binding is unavailable.");
            return (sender as (payload: string) => Promise<string>)(JSON.stringify(transaction));
          }

          if (
            method === "eth_sendRawTransaction" ||
            method === "eth_sign" ||
            method === "eth_signTransaction" ||
            method === "personal_sign" ||
            method.startsWith("personal_") ||
            method.startsWith("wallet_")
          ) {
            throw new Error(`Disposable test wallet refused browser RPC method ${method}.`);
          }

          if (!hasRpc) throw new Error(`Disposable test wallet does not implement ${method} without rpcUrl.`);
          const rpc = binding(rpcBinding);
          if (typeof rpc !== "function") throw new Error("Disposable test-wallet RPC binding is unavailable.");
          return (rpc as (method: string, params: unknown) => Promise<unknown>)(method, params ?? []);
        },
        on() {},
        removeListener() {},
      };
    },
    {
      address: account.address,
      chainId: fixture.chainId,
      signBinding: signBindingName,
      sendBinding: sendBindingName,
      rpcBinding: rpcBindingName,
      hasRpc: Boolean(fixture.rpcUrl),
    },
  );

  return account.address;
}
