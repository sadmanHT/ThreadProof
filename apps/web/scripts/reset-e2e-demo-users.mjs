import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_USERS = [
  { id: "11111111-1111-4111-8111-111111111111", email: "buyer.demo@threadproof.test" },
  { id: "22222222-2222-4222-8222-222222222222", email: "factory.demo@threadproof.test" },
  { id: "33333333-3333-4333-8333-333333333333", email: "auditor.demo@threadproof.test" },
  { id: "44444444-4444-4444-8444-444444444444", email: "governance.demo@threadproof.test" },
];

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const suppliedPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD?.trim();
const generatedPassword = suppliedPassword ? null : `TP-E2E-${randomBytes(24).toString("base64url")}!`;
const password = suppliedPassword ?? generatedPassword;

function fail(message) {
  throw new Error(message);
}

if (!supabaseUrl) fail("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL).");
if (!adminKey) fail("Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY. Use a server-side key only.");
if (!password || password.length < 16) fail("THREADPROOF_E2E_DEMO_PASSWORD must be at least 16 characters when supplied.");

const admin = createClient(supabaseUrl, adminKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

async function verifyFixtureIdentity() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) fail(`Unable to list Supabase Auth users: ${error.message}`);

  const usersById = new Map(data.users.map((user) => [user.id, user]));
  for (const expected of EXPECTED_USERS) {
    const actual = usersById.get(expected.id);
    if (!actual) fail(`Expected demo user is missing: ${expected.email} (${expected.id}).`);
    if ((actual.email ?? "").toLowerCase() !== expected.email) {
      fail(`Demo fixture identity mismatch for ${expected.id}; refusing to modify Auth users.`);
    }
    if (actual.deleted_at) fail(`Demo user is deleted: ${expected.email}.`);
  }
}

async function resetUsers() {
  for (const expected of EXPECTED_USERS) {
    const { data, error } = await admin.auth.admin.updateUserById(expected.id, {
      password,
      ban_duration: "none",
      email_confirm: true,
    });

    if (error) fail(`Failed to reset ${expected.email}: ${error.message}`);
    if (!data.user || data.user.id !== expected.id || data.user.email?.toLowerCase() !== expected.email) {
      fail(`Supabase returned an unexpected user while resetting ${expected.email}.`);
    }

    console.log(`✓ reset + unbanned ${expected.email}`);
  }
}

async function verifyPasswordLogin() {
  if (!publishableKey) {
    console.log("! login verification skipped: set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or SUPABASE_PUBLISHABLE_KEY) to verify password sign-in.");
    return;
  }

  for (const expected of EXPECTED_USERS) {
    const client = createClient(supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });

    const { data, error } = await client.auth.signInWithPassword({ email: expected.email, password });
    if (error || !data.user || data.user.id !== expected.id) {
      fail(`Password login verification failed for ${expected.email}${error ? `: ${error.message}` : "."}`);
    }

    await client.auth.signOut({ scope: "local" });
    console.log(`✓ password login verified ${expected.email}`);
  }
}

async function main() {
  console.log("ThreadProof E2E demo-user reset");
  console.log(`Project: ${new URL(supabaseUrl).host}`);
  console.log("Scope: exactly four fixed *.demo@threadproof.test fixtures");

  await verifyFixtureIdentity();
  await resetUsers();
  await verifyPasswordLogin();

  console.log("\nAll four ThreadProof demo users are ready for authenticated E2E tests.");
  if (generatedPassword) {
    console.log("\nGenerated shared E2E password (shown once):");
    console.log(generatedPassword);
    console.log("\nStore that exact value as the GitHub Actions secret THREADPROOF_E2E_DEMO_PASSWORD.");
  } else {
    console.log("\nThe supplied THREADPROOF_E2E_DEMO_PASSWORD was used and was not echoed.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unable to reset ThreadProof demo users.");
  process.exitCode = 1;
});
