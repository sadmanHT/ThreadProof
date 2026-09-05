import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const password = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const buyerEmail = "buyer.demo@threadproof.test";

if (!url || !publishableKey || !password) {
  console.error("Hosted E2E cleanup requires Supabase URL, publishable key, and THREADPROOF_E2E_DEMO_PASSWORD.");
  process.exit(1);
}

const supabase = createClient(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const { error: signInError } = await supabase.auth.signInWithPassword({ email: buyerEmail, password });
if (signInError) {
  console.error(`Unable to authenticate E2E cleanup buyer: ${signInError.message}`);
  process.exit(1);
}

try {
  const { data: drafts, error: listError } = await supabase
    .from("purchase_orders")
    .select("id,external_reference,status,current_version")
    .like("external_reference", "E2E-%")
    .eq("status", "draft")
    .eq("current_version", 0);

  if (listError) throw listError;

  let deleted = 0;
  for (const draft of drafts ?? []) {
    if (!draft.external_reference?.startsWith("E2E-")) {
      throw new Error(`Refusing to delete non-E2E draft ${draft.id}.`);
    }

    const { error } = await supabase.rpc("delete_purchase_order_draft", { target_order_id: draft.id });
    if (error) throw new Error(`Unable to delete stale E2E draft ${draft.id}: ${error.message}`);
    deleted += 1;
  }

  console.log(`ThreadProof E2E draft cleanup complete: ${deleted} stale draft(s) removed.`);
} finally {
  await supabase.auth.signOut({ scope: "local" });
}
