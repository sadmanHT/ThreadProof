import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const runId = process.env.THREADPROOF_BROWSER_E2E_RUN_ID?.trim();

if (!url || !serviceRoleKey || !runId) {
  console.error("Browser-chain cleanup requires Supabase URL, SUPABASE_SERVICE_ROLE_KEY, and THREADPROOF_BROWSER_E2E_RUN_ID.");
  process.exit(1);
}
if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) {
  console.error("THREADPROOF_BROWSER_E2E_RUN_ID contains unsafe characters.");
  process.exit(1);
}

const prefix = `E2E-CHAIN-${runId}-`;
const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

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

console.log(`ThreadProof browser-chain cleanup complete: ${deleted} namespaced anchored order(s) removed; 0 remain.`);
