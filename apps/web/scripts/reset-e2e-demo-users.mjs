import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_USERS = [
  { id: "11111111-1111-4111-8111-111111111111", email: "buyer.demo@threadproof.test" },
  { id: "22222222-2222-4222-8222-222222222222", email: "factory.demo@threadproof.test" },
  { id: "33333333-3333-4333-8333-333333333333", email: "auditor.demo@threadproof.test" },
  { id: "44444444-4444-4444-8444-444444444444", email: "governance.demo@threadproof.test" },
];

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
const adminKey = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)?.trim();
const suppliedPassword = process.env.THREADPROOF_E2E_DEMO_PASSWORD?.trim();
const generatedPassword = suppliedPassword ? null : `TP-E2E-${randomBytes(24).toString("base64url")}!`;
const password = suppliedPassword ?? generatedPassword;
const syncGitHubSecret = process.argv.includes("--sync-github-secret");
const githubRepository = process.env.GITHUB_REPOSITORY ?? "sadmanHT/ThreadProof";

function fail(message) {
  throw new Error(message);
}

function decodeLegacyJwtRole(key) {
  if (!key.startsWith("eyJ")) return null;
  try {
    const [, payload] = key.split(".");
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

function validateAdminKeyShape(key) {
  if (key.startsWith("sb_publishable_")) {
    fail(
      "A Supabase publishable key was provided. Open Supabase Dashboard → Project Settings → API Keys and use the server-side Secret key (sb_secret_...) or the legacy service_role key. Do not use the publishable/anon key or database password.",
    );
  }

  const legacyRole = decodeLegacyJwtRole(key);
  if (legacyRole === "anon") {
    fail(
      "A legacy Supabase anon key was provided. Open Supabase Dashboard → Project Settings → API Keys and copy the legacy service_role key instead, or use the newer sb_secret_... server key.",
    );
  }
  if (legacyRole && legacyRole !== "service_role") {
    fail(`The supplied legacy JWT has role '${legacyRole}', not service_role; refusing to use it for Auth Admin operations.`);
  }
}

if (!supabaseUrl) fail("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL).");
if (!adminKey) fail("Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY. Use a server-side key only.");
validateAdminKeyShape(adminKey);
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
  if (error) {
    const suffix = /invalid api key/i.test(error.message)
      ? " Open Supabase Dashboard → Project Settings → API Keys and use the server-side Secret key (sb_secret_...) or legacy service_role key for this project."
      : "";
    fail(`Unable to list Supabase Auth users: ${error.message}.${suffix}`);
  }

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

function syncPasswordToGitHub() {
  const result = spawnSync(
    "gh",
    ["secret", "set", "THREADPROOF_E2E_DEMO_PASSWORD", "--repo", githubRepository],
    {
      input: `${password}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  if (result.error) {
    fail(`Unable to run GitHub CLI: ${result.error.message}. The Supabase reset succeeded; rerun without --sync-github-secret to print the generated password for manual recovery.`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
    fail(`Unable to set GitHub Actions secret for ${githubRepository}: ${detail}. The Supabase reset succeeded; rerun with THREADPROOF_E2E_DEMO_PASSWORD set to the same password before retrying GitHub sync.`);
  }

  console.log(`✓ GitHub Actions secret THREADPROOF_E2E_DEMO_PASSWORD updated for ${githubRepository}`);
}

async function main() {
  console.log("ThreadProof E2E demo-user reset");
  console.log(`Project: ${new URL(supabaseUrl).host}`);
  console.log("Scope: exactly four fixed *.demo@threadproof.test fixtures");

  await verifyFixtureIdentity();
  await resetUsers();
  await verifyPasswordLogin();

  if (syncGitHubSecret) syncPasswordToGitHub();

  console.log("\nAll four ThreadProof demo users are ready for authenticated E2E tests.");
  if (syncGitHubSecret) {
    console.log("The shared password was synchronized directly to GitHub Actions and was not printed.");
  } else if (generatedPassword) {
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
