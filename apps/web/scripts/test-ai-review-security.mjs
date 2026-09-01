import fs from "node:fs";
import assert from "node:assert/strict";

const migration = fs.readFileSync(
  "supabase/migrations/20260901101040_threadproof_ai_review_invoker_hardening.sql",
  "utf8",
);
const triggerRepair = fs.readFileSync(
  "supabase/migrations/20260901101102_threadproof_ai_review_trigger_note_fix.sql",
  "utf8",
);
const actions = fs.readFileSync("apps/web/app/app/intelligence/actions.ts", "utf8");

const publicFunction = migration.match(
  /create or replace function public\.review_ai_finding\([\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(publicFunction, "public AI review RPC definition must remain inspectable");
assert.match(publicFunction, /security invoker/i, "public AI review RPC must run with caller privileges");
assert.doesNotMatch(publicFunction, /security definer/i, "public AI review RPC must never bypass RLS");
assert.match(publicFunction, /membership\.member_role in \('admin', 'operator', 'signer'\)/);
assert.match(publicFunction, /membership\.organization_id = target_organization_id/);
assert.match(publicFunction, /membership\.user_id = reviewer_id/);
assert.match(publicFunction, /finding\.organization_id = target_organization_id/);

assert.match(migration, /revoke update on table public\.ai_findings from authenticated/);
assert.match(migration, /grant update \(status, review_note\) on table public\.ai_findings to authenticated/);
assert.doesNotMatch(
  migration,
  /grant update on table public\.ai_findings to authenticated/i,
  "authenticated must never regain table-wide AI finding UPDATE",
);
assert.match(migration, /create policy ai_findings_operator_review_update[\s\S]*for update[\s\S]*to authenticated/i);
assert.match(migration, /membership\.member_role in \('admin', 'operator', 'signer'\)/);

const triggerFunction = migration.match(
  /create or replace function private\.stamp_ai_finding_review\(\)[\s\S]*?\n\$\$;/,
)?.[0];
assert.ok(triggerFunction, "AI review provenance trigger must remain inspectable");
assert.match(triggerFunction, /security invoker/i);
assert.doesNotMatch(triggerFunction, /security definer/i);
assert.match(triggerFunction, /reviewer_id uuid := \(select auth\.uid\(\)\)/);
assert.match(triggerFunction, /new\.reviewed_by := reviewer_id/);
assert.match(triggerFunction, /new\.reviewed_at := now\(\)/);
assert.match(triggerFunction, /new\.review_note := nullif\(btrim\(new\.review_note\), ''\)/);
assert.match(migration, /revoke all on function private\.stamp_ai_finding_review\(\) from public, anon, authenticated, service_role/);
assert.match(migration, /before update of status, review_note on public\.ai_findings/);

assert.match(triggerRepair, /security invoker/i);
assert.match(triggerRepair, /new\.review_note := nullif\(btrim\(new\.review_note\), ''\)/);
assert.doesNotMatch(triggerRepair, /btrim\(new_review_note\)/);

assert.match(actions, /!membership \|\| !hasOperationalRole\(membership\)/);
assert.match(actions, /supabase\.rpc\("review_ai_finding"/);

console.log(JSON.stringify({
  threadproof_ai_review_security_tests: "PASS",
  public_rpc: "security invoker",
  writable_columns: ["status", "review_note"],
  provenance_columns: "database-triggered and not authenticated-writable",
  organization_authorization: "RLS + RPC membership check",
}));
