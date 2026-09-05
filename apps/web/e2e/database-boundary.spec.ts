import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const demoPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD;
const hostedSupabaseConfigured = Boolean(supabaseUrl && publishableKey && demoPassword);

const DEMO_DRAFT_ORDER_ID = "10000000-0000-4000-8000-000000000001";
const DEMO_CAPACITY_OPENING_ID = "70000000-0000-4000-8000-000000000001";
const NONEXISTENT_ORDER_VERSION_ID = "00000000-0000-4000-8000-000000000001";
const NONEXISTENT_CAPACITY_OPENING_ID = "00000000-0000-4000-8000-000000000002";
const FAKE_SIGNER = `0x${"11".repeat(20)}`;

function client() {
  if (!supabaseUrl || !publishableKey) throw new Error("Hosted Supabase E2E configuration is missing.");
  return createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function signedInClient(email: string) {
  const supabase = client();
  const { error } = await supabase.auth.signInWithPassword({ email, password: demoPassword ?? "" });
  expect(error, `sign in ${email}`).toBeNull();
  return supabase;
}

test.describe("hosted Supabase trust boundaries", () => {
  test.skip(!hostedSupabaseConfigured, "Hosted Supabase E2E credentials are not configured.");

  test("factory proof queue reaches domain validation without private-opening UPDATE privilege", async () => {
    const supabase = await signedInClient("factory.demo@threadproof.test");
    try {
      const { error } = await supabase.rpc("queue_capacity_proof", {
        target_order_version_id: NONEXISTENT_ORDER_VERSION_ID,
        target_capacity_opening_id: NONEXISTENT_CAPACITY_OPENING_ID,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toContain("active capacity opening required");
      expect(error?.message.toLowerCase()).not.toContain("permission denied");
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });

  test("buyer cannot read the factory private capacity opening", async () => {
    const supabase = await signedInClient("buyer.demo@threadproof.test");
    try {
      const { data, error } = await supabase
        .from("private_capacity_openings")
        .select("id,capacity_commitment,encrypted_remaining_capacity,encrypted_randomness")
        .eq("id", DEMO_CAPACITY_OPENING_ID);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });

  test("auditor cannot read buyer purchase-order rows", async () => {
    const supabase = await signedInClient("auditor.demo@threadproof.test");
    try {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id,external_reference,title,quantity")
        .eq("id", DEMO_DRAFT_ORDER_ID);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });

  test("factory browser session cannot mutate the private capacity mirror directly", async () => {
    const supabase = await signedInClient("factory.demo@threadproof.test");
    try {
      const { error } = await supabase
        .from("private_capacity_openings")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", DEMO_CAPACITY_OPENING_ID);

      expect(error).not.toBeNull();
      expect(error?.message.toLowerCase()).toContain("permission denied");
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });

  test("buyer browser session cannot forge relayer-validated signer evidence", async () => {
    const supabase = await signedInClient("buyer.demo@threadproof.test");
    try {
      for (const table of ["order_authorization_jobs", "order_cancellation_jobs"] as const) {
        const { error } = await supabase
          .from(table)
          .update({ validated_buyer_signer: FAKE_SIGNER })
          .eq("id", NONEXISTENT_ORDER_VERSION_ID);

        expect(error, `${table} validated signer update must be denied`).not.toBeNull();
        expect(error?.message.toLowerCase()).toContain("permission denied");
      }
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });

  test("draft update RPC rejects invalid fields below the UI layer", async () => {
    const supabase = await signedInClient("buyer.demo@threadproof.test");
    try {
      const { data: before, error: readError } = await supabase
        .from("purchase_orders")
        .select("external_reference,title,product_category,quantity,unit,requested_delivery_date")
        .eq("id", DEMO_DRAFT_ORDER_ID)
        .single();
      expect(readError).toBeNull();
      expect(before).not.toBeNull();

      const { error } = await supabase.rpc("update_purchase_order_draft", {
        target_order_id: DEMO_DRAFT_ORDER_ID,
        new_external_reference: before?.external_reference ?? "DEMO-PO-001",
        new_title: " ",
        new_product_category: before?.product_category ?? "",
        new_quantity: before?.quantity ?? 1,
        new_unit: before?.unit ?? "pieces",
        new_requested_delivery_date: before?.requested_delivery_date ?? undefined,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toContain("title must be between 2 and 180 characters");

      const { data: after, error: rereadError } = await supabase
        .from("purchase_orders")
        .select("title")
        .eq("id", DEMO_DRAFT_ORDER_ID)
        .single();
      expect(rereadError).toBeNull();
      expect(after?.title).toBe(before?.title);
    } finally {
      await supabase.auth.signOut({ scope: "local" });
    }
  });
});
