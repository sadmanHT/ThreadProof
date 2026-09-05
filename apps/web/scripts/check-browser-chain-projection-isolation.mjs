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

const [{ count: eventCount, error: eventError }, { data: cursor, error: cursorError }] = await Promise.all([
  supabase.from("chain_events").select("id", { count: "exact", head: true }).eq("chain_id", chainId),
  supabase
    .from("chain_indexer_cursors")
    .select("chain_id,last_block_number,last_block_hash,status")
    .eq("chain_id", chainId)
    .maybeSingle(),
]);

if (eventError) throw eventError;
if (cursorError) throw cursorError;

if ((eventCount ?? 0) !== 0 || cursor) {
  console.error(
    `Browser-to-chain integration refuses shared projection state for chain ${chainId}: ` +
      `${eventCount ?? 0} chain event(s), cursor=${cursor ? `${cursor.last_block_number}@${cursor.last_block_hash}` : "none"}.`,
  );
  console.error(
    "Use a dedicated E2E Supabase project or clear only previously verified disposable integration state before retrying. " +
      "The workflow will not reuse, quarantine, overwrite, or delete an existing canonical cursor.",
  );
  process.exit(1);
}

console.log(`Browser-chain projection isolation verified for chain ${chainId}: no cursor and no persisted chain events.`);
