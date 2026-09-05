import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const chainId = Number(process.env.THREADPROOF_CHAIN_ID ?? 0);

if (!url || !serviceRoleKey || !Number.isSafeInteger(chainId) || chainId <= 0) {
  console.error("Browser-chain projection preflight requires Supabase URL, SUPABASE_SERVICE_ROLE_KEY, and a positive THREADPROOF_CHAIN_ID.");
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function loadProjectionState() {
  const [events, cursorResult, provenance] = await Promise.all([
    supabase.from("chain_events").select("id", { count: "exact", head: true }).eq("chain_id", chainId),
    supabase
      .from("chain_indexer_cursors")
      .select("chain_id,last_block_number,last_block_hash,status")
      .eq("chain_id", chainId)
      .maybeSingle(),
    supabase
      .from("verifier_provenance_read_model")
      .select("circuit_version", { count: "exact", head: true })
      .eq("chain_id", chainId),
  ]);

  if (events.error) throw events.error;
  if (cursorResult.error) throw cursorResult.error;
  if (provenance.error) throw provenance.error;

  return {
    eventCount: events.count ?? 0,
    cursor: cursorResult.data,
    provenanceCount: provenance.count ?? 0,
  };
}

let state = await loadProjectionState();

if (state.eventCount === 0 && state.provenanceCount === 0 && state.cursor) {
  console.warn(
    `Browser-chain projection preflight found an otherwise empty chain ${chainId} projection with cursor ` +
      `${state.cursor.last_block_number}@${state.cursor.last_block_hash}; asking the server-side recovery gate to reap it only if both the cursor and every chain indexer heartbeat are stale.`,
  );

  const { error: recoveryError } = await supabase.rpc("reap_orphan_browser_chain_e2e_cursor", {
    target_chain_id: chainId,
    expected_cursor_block: state.cursor.last_block_number,
    expected_cursor_hash: state.cursor.last_block_hash,
  });

  if (recoveryError) {
    console.error(
      `Browser-chain orphan cursor recovery refused the state: ${recoveryError.message}. ` +
        "This is a fail-closed result; a fresh or changed cursor must never be deleted by test preflight.",
    );
    process.exit(1);
  }

  state = await loadProjectionState();
}

if (state.eventCount !== 0 || state.cursor) {
  console.error(
    `Browser-to-chain integration refuses shared projection state for chain ${chainId}: ` +
      `${state.eventCount} chain event(s), cursor=${state.cursor ? `${state.cursor.last_block_number}@${state.cursor.last_block_hash}` : "none"}, ` +
      `${state.provenanceCount} verifier provenance row(s).`,
  );
  console.error(
    "Use a dedicated E2E Supabase project or clear only previously verified disposable integration state before retrying. " +
      "The workflow will not reuse, quarantine, overwrite, or delete an existing canonical cursor.",
  );
  process.exit(1);
}

if (state.provenanceCount > 0) {
  console.warn(
    `Browser-chain projection preflight found ${state.provenanceCount} orphaned verifier provenance row(s) for chain ${chainId} with no chain events or cursor; removing only that rebuildable read-model residue through the serialized cleanup gate.`,
  );
  const { error: cleanupError } = await supabase.rpc("cleanup_browser_chain_e2e_projection", {
    target_chain_id: chainId,
    expected_event_count: 0,
    expected_cursor_block: null,
    expected_cursor_hash: null,
  });
  if (cleanupError) {
    throw new Error(`Unable to clear orphaned browser-chain verifier provenance: ${cleanupError.message}`);
  }
  state = await loadProjectionState();
}

if (state.eventCount !== 0 || state.cursor || state.provenanceCount !== 0) {
  console.error(
    `Browser-to-chain integration could not establish empty projection state for chain ${chainId}: ` +
      `${state.eventCount} chain event(s), cursor=${state.cursor ? `${state.cursor.last_block_number}@${state.cursor.last_block_hash}` : "none"}, ` +
      `${state.provenanceCount} verifier provenance row(s).`,
  );
  process.exit(1);
}

console.log(`Browser-chain projection isolation verified for chain ${chainId}: no cursor, persisted chain events, or verifier provenance rows.`);
