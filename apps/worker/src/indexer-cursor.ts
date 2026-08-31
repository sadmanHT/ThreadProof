import type { Hex } from "viem";

export type IndexerCursor = {
  chainId: number;
  lastBlockNumber: bigint;
  lastBlockHash: Hex;
  status: "healthy" | "reorg_detected";
};

export class IndexerCanonicalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerCanonicalityError";
  }
}

export function safeIndexerHead(head: bigint, confirmations: bigint) {
  if (confirmations <= 0n) throw new Error("Indexer confirmations must be at least 1.");
  const lag = confirmations - 1n;
  return head < lag ? null : head - lag;
}

export function nextIndexerRange(args: {
  cursor: IndexerCursor | null;
  startBlock: bigint;
  safeHead: bigint | null;
  batchSize: bigint;
}) {
  if (args.batchSize <= 0n) throw new Error("Indexer batch size must be positive.");
  if (args.safeHead == null) return null;
  if (args.cursor?.status === "reorg_detected") {
    throw new IndexerCanonicalityError(
      "Indexer cursor is quarantined after a canonicality failure; rebuild or reconcile it explicitly before resuming.",
    );
  }

  const fromBlock = args.cursor == null ? args.startBlock : args.cursor.lastBlockNumber + 1n;
  if (fromBlock > args.safeHead) return null;
  const candidateTo = fromBlock + args.batchSize - 1n;
  return {
    fromBlock,
    toBlock: candidateTo > args.safeHead ? args.safeHead : candidateTo,
  };
}

export function assertCursorBlockHash(
  cursor: IndexerCursor,
  canonicalHash: Hex | null | undefined,
) {
  if (!canonicalHash) {
    throw new IndexerCanonicalityError(
      `Canonical RPC did not return block ${cursor.lastBlockNumber} required to verify the indexer cursor.`,
    );
  }
  if (canonicalHash.toLowerCase() !== cursor.lastBlockHash.toLowerCase()) {
    throw new IndexerCanonicalityError(
      `Indexer cursor block ${cursor.lastBlockNumber} hash ${cursor.lastBlockHash} no longer matches canonical RPC hash ${canonicalHash}.`,
    );
  }
}
