import "server-only";
import { createPublicClient, http, type Address, type Hex } from "viem";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const CONTRACT_CONFIG = [
  ["registry", "Organization registry", "THREADPROOF_REGISTRY_ADDRESS", "Consortium organizations and status"],
  ["credentials", "Credential registry", "THREADPROOF_CREDENTIAL_REGISTRY_ADDRESS", "Compliance credential lifecycle"],
  ["orders", "Order registry", "THREADPROOF_ORDER_REGISTRY_ADDRESS", "Canonical order versions and cancellation"],
  ["capacity", "Capacity vault", "THREADPROOF_CAPACITY_VAULT_ADDRESS", "PoFC capacity commitments and ZK spends"],
  ["subcontract", "Subcontract governor", "THREADPROOF_SUBCONTRACT_GOVERNOR_ADDRESS", "Controlled subcontract authorization"],
  ["charter", "Protocol charter", "THREADPROOF_CHARTER_ADDRESS", "Governance policy and privileged actions"],
] as const;

export type BlockchainContractStatus = {
  key: (typeof CONTRACT_CONFIG)[number][0];
  name: string;
  purpose: string;
  address: string | null;
  configured: boolean;
  validAddress: boolean;
  hasCode: boolean | null;
};

export type BlockchainStatus = {
  configured: boolean;
  online: boolean;
  chainId: number | null;
  expectedChainId: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  blockTimestamp: string | null;
  blockAgeSeconds: number | null;
  peerCount: number | null;
  syncing: boolean | null;
  clientVersion: string | null;
  contractsConfigured: number;
  contractsDeployed: number;
  contractsReady: boolean;
  contracts: BlockchainContractStatus[];
  error: string | null;
};

export type TransactionProvenance = {
  configured: boolean;
  online: boolean;
  found: boolean;
  txHash: string;
  chainId: number | null;
  status: "success" | "reverted" | "pending" | "not_found" | "unavailable";
  blockNumber: string | null;
  blockHash: string | null;
  canonicalBlockHash: string | null;
  canonical: boolean | null;
  confirmations: string | null;
  from: string | null;
  to: string | null;
  contractAddress: string | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  transactionIndex: number | null;
  error: string | null;
};

function configuredChainId() {
  const raw = process.env.THREADPROOF_CHAIN_ID;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

function contractConfiguration(): BlockchainContractStatus[] {
  return CONTRACT_CONFIG.map(([key, name, envKey, purpose]) => {
    const address = process.env[envKey]?.trim() || null;
    const validAddress = address !== null && ADDRESS_PATTERN.test(address) && !/^0x0{40}$/i.test(address);
    return {
      key,
      name,
      purpose,
      address,
      configured: address !== null,
      validAddress,
      hasCode: null,
    };
  });
}

async function optionalRpc(client: any, method: string): Promise<unknown | null> {
  try {
    return await client.request({ method });
  } catch {
    return null;
  }
}

function parseHexQuantity(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number(BigInt(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function inspectContracts(client: ReturnType<typeof createPublicClient>, contracts: BlockchainContractStatus[]) {
  return Promise.all(contracts.map(async (contract) => {
    if (!contract.validAddress || !contract.address) return contract;
    try {
      const bytecode = await client.getBytecode({ address: contract.address as Address });
      return { ...contract, hasCode: typeof bytecode === "string" && bytecode !== "0x" };
    } catch {
      return { ...contract, hasCode: false };
    }
  }));
}

export async function getBlockchainStatus(): Promise<BlockchainStatus> {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const expectedChainId = configuredChainId();
  const configuredContracts = contractConfiguration();
  const configuredContractCount = configuredContracts.filter((contract) => contract.configured).length;

  if (!rpcUrl) {
    return {
      configured: false,
      online: false,
      chainId: null,
      expectedChainId: null,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      blockAgeSeconds: null,
      peerCount: null,
      syncing: null,
      clientVersion: null,
      contractsConfigured: configuredContractCount,
      contractsDeployed: 0,
      contractsReady: false,
      contracts: configuredContracts,
      error: null,
    };
  }

  if (Number.isNaN(expectedChainId)) {
    return {
      configured: true,
      online: false,
      chainId: null,
      expectedChainId: null,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      blockAgeSeconds: null,
      peerCount: null,
      syncing: null,
      clientVersion: null,
      contractsConfigured: configuredContractCount,
      contractsDeployed: 0,
      contractsReady: false,
      contracts: configuredContracts,
      error: "Configured consortium chain ID is invalid",
    };
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
    const [chainId, block, peerCountRaw, syncingRaw, clientVersionRaw] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockTag: "latest" }),
      optionalRpc(client, "net_peerCount"),
      optionalRpc(client, "eth_syncing"),
      optionalRpc(client, "web3_clientVersion"),
    ]);

    const contracts = await inspectContracts(client, configuredContracts);
    const contractsDeployed = contracts.filter((contract) => contract.hasCode === true).length;
    const contractsReady = contracts.length > 0 && contracts.every((contract) => contract.validAddress && contract.hasCode === true);
    const blockTimestampSeconds = Number(block.timestamp);
    const blockAgeSeconds = Number.isSafeInteger(blockTimestampSeconds)
      ? Math.max(0, Math.floor(Date.now() / 1000) - blockTimestampSeconds)
      : null;
    const peerCount = parseHexQuantity(peerCountRaw);
    const syncing = syncingRaw === null ? null : syncingRaw !== false;
    const clientVersion = typeof clientVersionRaw === "string" ? clientVersionRaw : null;

    if (expectedChainId !== null && chainId !== expectedChainId) {
      return {
        configured: true,
        online: false,
        chainId,
        expectedChainId,
        blockNumber: block.number?.toString() ?? null,
        blockHash: block.hash ?? null,
        blockTimestamp: block.timestamp.toString(),
        blockAgeSeconds,
        peerCount,
        syncing,
        clientVersion,
        contractsConfigured: configuredContractCount,
        contractsDeployed,
        contractsReady: false,
        contracts,
        error: "Connected RPC is serving the wrong consortium chain",
      };
    }

    return {
      configured: true,
      online: true,
      chainId,
      expectedChainId,
      blockNumber: block.number?.toString() ?? null,
      blockHash: block.hash ?? null,
      blockTimestamp: block.timestamp.toString(),
      blockAgeSeconds,
      peerCount,
      syncing,
      clientVersion,
      contractsConfigured: configuredContractCount,
      contractsDeployed,
      contractsReady,
      contracts,
      error: null,
    };
  } catch {
    return {
      configured: true,
      online: false,
      chainId: null,
      expectedChainId: expectedChainId === null ? null : expectedChainId,
      blockNumber: null,
      blockHash: null,
      blockTimestamp: null,
      blockAgeSeconds: null,
      peerCount: null,
      syncing: null,
      clientVersion: null,
      contractsConfigured: configuredContractCount,
      contractsDeployed: 0,
      contractsReady: false,
      contracts: configuredContracts,
      error: "Unable to reach consortium chain",
    };
  }
}

export async function getTransactionProvenance(txHash: string): Promise<TransactionProvenance> {
  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const expectedChainId = configuredChainId();
  const unavailable = (error: string): TransactionProvenance => ({
    configured: Boolean(rpcUrl),
    online: false,
    found: false,
    txHash,
    chainId: null,
    status: "unavailable",
    blockNumber: null,
    blockHash: null,
    canonicalBlockHash: null,
    canonical: null,
    confirmations: null,
    from: null,
    to: null,
    contractAddress: null,
    gasUsed: null,
    effectiveGasPrice: null,
    transactionIndex: null,
    error,
  });

  if (!TX_HASH_PATTERN.test(txHash)) return unavailable("Transaction hash is malformed");
  if (!rpcUrl) return unavailable("Consortium RPC is not configured");
  if (Number.isNaN(expectedChainId)) return unavailable("Configured consortium chain ID is invalid");

  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000, retryCount: 1 }) });
    const chainId = await client.getChainId();
    if (expectedChainId !== null && chainId !== expectedChainId) {
      return { ...unavailable("Connected RPC is serving the wrong consortium chain"), chainId };
    }

    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
      const [canonicalBlock, head] = await Promise.all([
        client.getBlock({ blockNumber: receipt.blockNumber }),
        client.getBlockNumber(),
      ]);
      const canonicalBlockHash = canonicalBlock.hash ?? null;
      const canonical = Boolean(canonicalBlockHash && canonicalBlockHash.toLowerCase() === receipt.blockHash.toLowerCase());
      const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;

      return {
        configured: true,
        online: true,
        found: true,
        txHash,
        chainId,
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        canonicalBlockHash,
        canonical,
        confirmations: confirmations.toString(),
        from: receipt.from,
        to: receipt.to,
        contractAddress: receipt.contractAddress,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        transactionIndex: receipt.transactionIndex,
        error: canonical ? null : "Receipt block hash does not match the current canonical block hash",
      };
    } catch {
      try {
        const tx = await client.getTransaction({ hash: txHash as Hex });
        if (tx.blockNumber == null) {
          return {
            configured: true,
            online: true,
            found: true,
            txHash,
            chainId,
            status: "pending",
            blockNumber: null,
            blockHash: null,
            canonicalBlockHash: null,
            canonical: null,
            confirmations: "0",
            from: tx.from,
            to: tx.to,
            contractAddress: null,
            gasUsed: null,
            effectiveGasPrice: null,
            transactionIndex: null,
            error: null,
          };
        }
      } catch {
        // The canonical RPC does not know this transaction.
      }

      return {
        configured: true,
        online: true,
        found: false,
        txHash,
        chainId,
        status: "not_found",
        blockNumber: null,
        blockHash: null,
        canonicalBlockHash: null,
        canonical: null,
        confirmations: null,
        from: null,
        to: null,
        contractAddress: null,
        gasUsed: null,
        effectiveGasPrice: null,
        transactionIndex: null,
        error: "Transaction was not found on the configured consortium RPC",
      };
    }
  } catch {
    return unavailable("Unable to reach consortium chain");
  }
}
