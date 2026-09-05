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
const stage2Prefix = `${prefix}POFC-`;
const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function assertNoStage2ForbiddenDescendants(order) {
  const { data: versions, error: versionsError } = await supabase
    .from("order_versions")
    .select("id")
    .eq("purchase_order_id", order.id);
  if (versionsError) throw versionsError;
  const versionIds = (versions ?? []).map((version) => version.id);

  const [subcontracts, cancellations] = await Promise.all([
    supabase
      .from("subcontract_authorization_jobs")
      .select("id", { count: "exact", head: true })
      .or(`parent_order_id.eq.${order.id},child_order_id.eq.${order.id}`),
    supabase
      .from("order_cancellation_jobs")
      .select("id", { count: "exact", head: true })
      .eq("purchase_order_id", order.id),
  ]);
  if (subcontracts.error) throw subcontracts.error;
  if (cancellations.error) throw cancellations.error;
  if ((subcontracts.count ?? 0) > 0 || (cancellations.count ?? 0) > 0) {
    throw new Error(`Refusing Stage-2 cleanup for order ${order.id}: subcontract or cancellation state exists.`);
  }

  if (versionIds.length > 0) {
    const releases = await supabase
      .from("capacity_release_jobs")
      .select("id", { count: "exact", head: true })
      .in("order_version_id", versionIds);
    if (releases.error) throw releases.error;
    if ((releases.count ?? 0) > 0) {
      throw new Error(`Refusing Stage-2 cleanup for order ${order.id}: capacity-release state exists.`);
    }
  }
}

async function cleanupStage1Order(order) {
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

  const { data: removed, error: deleteError } = await supabase.rpc("cleanup_browser_chain_e2e_order", {
    target_order_id: order.id,
    target_run_id: runId,
  });
  if (deleteError) throw new Error(`Unable to delete Stage-1 browser-chain fixture ${order.id}: ${deleteError.message}`);
  if (removed !== true) throw new Error(`Stage-1 browser-chain fixture ${order.id} disappeared before guarded cleanup completed.`);
}

async function cleanupStage2Order(order) {
  if (!order.external_reference?.startsWith(stage2Prefix)) {
    throw new Error(`Refusing Stage-2 cleanup outside ${stage2Prefix}: ${order.id}.`);
  }
  await assertNoStage2ForbiddenDescendants(order);

  const { data: removed, error: deleteError } = await supabase.rpc("cleanup_browser_chain_stage2_e2e_fixture", {
    target_order_id: order.id,
    target_run_id: runId,
  });
  if (deleteError) throw new Error(`Unable to delete Stage-2 browser-chain fixture ${order.id}: ${deleteError.message}`);
  if (removed !== true) throw new Error(`Stage-2 browser-chain fixture ${order.id} disappeared before guarded cleanup completed.`);
}

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

    if (order.external_reference.startsWith(stage2Prefix)) {
      await cleanupStage2Order(order);
    } else {
      await cleanupStage1Order(order);
    }
    deleted += 1;
  }

  const [{ count: remainingOrders, error: remainingOrderError }, { count: remainingCertifications, error: remainingCertificationError }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .like("external_reference", `${prefix}%`),
    supabase
      .from("capacity_certification_jobs")
      .select("id", { count: "exact", head: true })
      .like("period_label", `${stage2Prefix}%`),
  ]);
  if (remainingOrderError) throw remainingOrderError;
  if (remainingCertificationError) throw remainingCertificationError;
  if ((remainingOrders ?? 0) !== 0 || (remainingCertifications ?? 0) !== 0) {
    throw new Error(
      `Browser-chain cleanup left ${remainingOrders ?? 0} order fixture(s) or ${remainingCertifications ?? 0} Stage-2 certification fixture(s).`,
    );
  }

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

  const { error: cleanupError } = await supabase.rpc("cleanup_browser_chain_e2e_projection", {
    target_chain_id: chainId,
    expected_event_count: (events ?? []).length,
    expected_cursor_block: cursor?.last_block_number ?? null,
    expected_cursor_hash: cursor?.last_block_hash ?? null,
  });
  if (cleanupError) {
    throw new Error(`Unable to atomically clean verified browser-chain projection state: ${cleanupError.message}`);
  }

  const [remainingEventsResult, remainingCursorResult, remainingProvenanceResult] = await Promise.all([
    supabase.from("chain_events").select("id", { count: "exact", head: true }).eq("chain_id", chainId),
    supabase.from("chain_indexer_cursors").select("chain_id").eq("chain_id", chainId).maybeSingle(),
    supabase
      .from("verifier_provenance_read_model")
      .select("circuit_version", { count: "exact", head: true })
      .eq("chain_id", chainId),
  ]);
  if (remainingEventsResult.error) throw remainingEventsResult.error;
  if (remainingCursorResult.error) throw remainingCursorResult.error;
  if (remainingProvenanceResult.error) throw remainingProvenanceResult.error;

  const remainingEvents = remainingEventsResult.count ?? 0;
  const remainingCursor = remainingCursorResult.data;
  const remainingProvenance = remainingProvenanceResult.count ?? 0;
  if (remainingEvents !== 0 || remainingCursor || remainingProvenance !== 0) {
    throw new Error(
      `Browser-chain projection cleanup left ${remainingEvents} event(s), ${remainingProvenance} verifier provenance row(s), or a cursor for chain ${chainId}.`,
    );
  }

  console.log(`ThreadProof browser-chain projection cleanup complete for chain ${chainId}; verified block ownership before deletion and removed derived verifier provenance.`);
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
