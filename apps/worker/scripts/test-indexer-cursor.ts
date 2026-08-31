import assert from "node:assert/strict";
import type { Hex } from "viem";
import {
  IndexerCanonicalityError,
  assertCursorBlockHash,
  nextIndexerRange,
  safeIndexerHead,
  type IndexerCursor,
} from "../src/indexer-cursor.js";

const HASH_A = `0x${"11".repeat(32)}` as Hex;
const HASH_B = `0x${"22".repeat(32)}` as Hex;
const cursor: IndexerCursor = {
  chainId: 2026,
  lastBlockNumber: 100n,
  lastBlockHash: HASH_A,
  status: "healthy",
};

assert.equal(safeIndexerHead(100n, 1n), 100n);
assert.equal(safeIndexerHead(100n, 3n), 98n);
assert.equal(safeIndexerHead(0n, 2n), null);
assert.throws(() => safeIndexerHead(10n, 0n), /at least 1/);

assert.deepEqual(
  nextIndexerRange({ cursor: null, startBlock: 50n, safeHead: 55n, batchSize: 3n }),
  { fromBlock: 50n, toBlock: 52n },
);
assert.deepEqual(
  nextIndexerRange({ cursor, startBlock: 0n, safeHead: 103n, batchSize: 10n }),
  { fromBlock: 101n, toBlock: 103n },
);
assert.equal(nextIndexerRange({ cursor, startBlock: 0n, safeHead: 100n, batchSize: 10n }), null);

assert.doesNotThrow(() => assertCursorBlockHash(cursor, HASH_A));
assert.throws(
  () => assertCursorBlockHash(cursor, HASH_B),
  (error: unknown) => error instanceof IndexerCanonicalityError && /no longer matches canonical RPC hash/.test(error.message),
);
assert.throws(
  () => assertCursorBlockHash(cursor, null),
  (error: unknown) => error instanceof IndexerCanonicalityError && /did not return block 100/.test(error.message),
);
assert.throws(
  () => nextIndexerRange({ cursor: { ...cursor, status: "reorg_detected" }, startBlock: 0n, safeHead: 200n, batchSize: 10n }),
  (error: unknown) => error instanceof IndexerCanonicalityError && /quarantined/.test(error.message),
);

console.log("ThreadProof indexer cursor canonicality checks passed");
