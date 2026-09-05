import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const runId = process.env.THREADPROOF_BROWSER_E2E_RUN_ID?.trim();
const projectionOwned = process.env.THREADPROOF_BROWSER_E2E_PROJECTION_OWNED === "true";

if (!url || !serviceRoleKey || !runId) {
  console.log(
    "ThreadProof browser-chain cleanup skipped: setup credentials or run namespace are unavailable, so no namespaced fixture could have been created by this run.",
  );
  process.exit(0);
}
if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) {
  console.error("THREADPROOF_BROWSER_E2E_RUN_ID contains unsafe characters.");
  process.exit(1);
}

const prefix = `E2E-CHAIN-${runId}-`;
const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function cleanupNamespacedOrders() {
  const { data: orders, error: listError } = await supabase
    .from("purchase_orders")
    .select("id,external_reference")
    .like("external_reference", `${prefix}%`);
  if (listError) throw listError;

  let deleted = 0;
  for (const order of orders ?? []) {
    if (!order.external_reference?.startsWith(prefix)) {
      throw new Error(`Refusing to clean non-namespaced order ${order.id}.`);
    }

    const { data: versions, error: versionsError } = await supabase
      .from("order_versions")
      .select("id")
      .eq("purchase_order_id", order.id);
    if (versionsError) throw versionsError;
    const versionIds = (versions ?? []).map((version) => version.id);

    if (versionIds.length > 0) {
      const [proofs, allocations, releases] = await Promise.all([
        supabase.from("proof_jobs").select("id", { count: "exact", head: true }).in("order_version_id", versionIds),
        supabase.from("capacity_allocations").select("id", { count: "exact", head: true }).in("order_version_id", versionIds),
        supabase.from("capacity_release_jobs").select("id", { count: "exact", head: true }).in("order_version_id", versionIds),
      ]);
      for (const [label, result] of [["proof jobs", proofs], ["capacity allocations", allocations], ["capacity release jobs", releases]]) {
        if (result.error) throw result.error;
        if ((result.count ?? 0) > 0) {
          throw new Error(`Refusing to clean Stage-1 order ${order.id}: dependent ${label} exist.`);
        }
      }
    }

    const { count: subcontractCount, error: subcontractError } = await supabase
      .from("subcontract_authorization_jobs")
      .select("id", { count: "exact", head: true })
      .or(`parent_order_id.eq.${order.id},child_order_id.eq.${order.id}`);
    if (subcontractError) throw subcontractError;
    if ((subcontractCount ?? 0) > 0) {
      throw new Error(`Refusing to clean Stage-1 order ${order.id}: subcontract authorization work exists.`);
    }

    const { error: deleteError } = await supabase.from("purchase_orders").delete().eq("id", order.id);
    if (deleteError) throw new Error(`Unable to delete browser-chain fixture ${order.id}: ${deleteError.message}`);
    deleted += 1;
  }

  const { count: remaining, error: remainingError } = await supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .like("external_reference", `${prefix}%`);
  if (remainingError) throw remainingError;
  if ((remaining ?? 0) !== 0) throw new Error(`Browser-chain cleanup left ${remaining} order fixture(s).`);

  return deleted;
}

async function cleanupOwnedProjectionState() {
  if (!projectionOwned) {
    console.log("Browser-chain projection cleanup skipped: this run never established exclusive projection ownership.");
    return;
  }

  const rpcUrl = process.env.THREADPROOF_RPC_URL;
  const chainId = Number(process.env.THREADPROOF_CHAIN_ID ?? 0);
  if (!rpcUrl || !Number.isSafeInteger(chainId) || chainId <= 0) {
    console.log("Browser-chain projection cleanup skipped: the disposable RPC was never established.");
    return;
  }

  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000 }) });
  const actualChainId = await client.getChainId();
  if (actualChainId !== chainId) {
    throw new Error(`Refusing projection cleanup: RPC chain ${actualChainId} does not match configured chain ${chainId}.`);
  }

  const [{ data: events, error: eventsError }, { data: cursor, error: cursorError }] = await Promise.all([
    supabase
      .from("chain_events")
      .select("id,block_number,block_hash")
      .eq("chain_id", chainId)
      .order("block_number", { ascending: true }),
    supabase
      .from("chain_indexer_cursors")
      .select("chain_id,last_block_number,last_block_hash,status")
      .eq("chain_id", chainId)
      .maybeSingle(),
  ]);
  if (eventsError) throw eventsError;
  if (cursorError) throw cursorError;

  const canonicalBlockHashes = new Map();
  async function canonicalHash(blockNumber) {
    const key = String(blockNumber);
    const cached = canonicalBlockHashes.get(key);
    if (cached) return cached;
    const block = await client.getBlock({ blockNumber: BigInt(key) });
    if (!block.hash) throw new Error(`Disposable RPC returned block ${key} without a hash during cleanup.`);
    canonicalBlockHashes.set(key, block.hash.toLowerCase());
    return block.hash.toLowerCase();
  }

  for (const event of events ?? []) {
    const expected = await canonicalHash(event.block_number);
    if (String(event.block_hash).toLowerCase() !== expected) {
      throw new Error(
        `Refusing projection cleanup: chain event ${event.id} at block ${event.block_number} does not belong to this disposable chain.`,
      );
    }
  }

  if (cursor) {
    const expected = await canonicalHash(cursor.last_block_number);
    if (String(cursor.last_block_hash).toLowerCase() !== expected) {
      throw new Error(
        `Refusing projection cleanup: stored cursor ${cursor.last_block_number}@${cursor.last_block_hash} does not belong to this disposable chain.`,
      );
    }
  }

  if ((events ?? []).length > 0) {
    const { error } = await supabase.from("chain_events").delete().eq("chain_id", chainId);
    if (error) throw error;
  }
  if (cursor) {
    const { error } = await supabase
      .from("chain_indexer_cursors")
      .delete()
      .eq("chain_id", chainId)
      .eq("last_block_number", cursor.last_block_number)
      .eq("last_block_hash", cursor.last_block_hash);
    if (error) throw error;
  }

  const [{ count: remainingEvents, error: remainingEventsError }, { data: remainingCursor, error: remainingCursorError }] = await Promise.all([
    supabase.from("chain_events").select("id", { count: "exact", head: true }).eq("chain_id", chainId),
    supabase.from("chain_indexer_cursors").select("chain_id").eq("chain_id", chainId).maybeSingle(),
  ]);
  if (remainingEventsError) throw remainingEventsError;
  if (remainingCursorError) throw remainingCursorError;
  if ((remainingEvents ?? 0) !== 0 || remainingCursor) {
    throw new Error(`Browser-chain projection cleanup left ${remainingEvents ?? 0} event(s) or a cursor for chain ${chainId}.`);
  }

  console.log(`ThreadProof browser-chain projection cleanup complete for chain ${chainId}; verified block ownership before deletion.`);
}

let deleted = 0;
let orderFailure = null;
let projectionFailure = null;
try {
  deleted = await cleanupNamespacedOrders();
} catch (error) {
  orderFailure = error;
}
try {
  await cleanupOwnedProjectionState();
} catch (error) {
  projectionFailure = error;
}

if (orderFailure && projectionFailure) {
  throw new AggregateError([orderFailure, projectionFailure], "Browser-chain order and projection cleanup both failed.");
}
if (orderFailure) throw orderFailure;
if (projectionFailure) throw projectionFailure;

console.log(`ThreadProof browser-chain cleanup complete: ${deleted} namespaced anchored order(s) removed; 0 remain.`);
