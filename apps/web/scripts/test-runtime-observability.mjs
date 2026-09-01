import fs from "node:fs";
import assert from "node:assert/strict";

const read = (path) => fs.readFileSync(path, "utf8");
const heartbeat = read("apps/worker/src/runtime-heartbeat.ts");
const operations = read("apps/web/app/app/operations/page.tsx");
const healthRoute = read("apps/web/app/api/health/route.ts");
const migration = read("supabase/migrations/20260901094532_threadproof_worker_runtime_observability.sql");

const workers = [
  ["indexer", "apps/worker/src/run-indexer.ts", false],
  ["order_relayer", "apps/worker/src/run-order-relayer.ts", true],
  ["subcontract_relayer", "apps/worker/src/run-subcontract-relayer.ts", true],
  ["proof_generator", "apps/worker/src/run-proof-generator.ts", false],
  ["proof_submitter", "apps/worker/src/run-proof-submitter.ts", true],
];

for (const [workerType, path, requiresSigner] of workers) {
  const source = read(path);
  const readiness = source.indexOf("createVerifiedPublicClient");
  const heartbeatStart = source.indexOf(`startWorkerRuntimeHeartbeat("${workerType}"`);
  assert.ok(readiness >= 0, `${workerType} must verify canonical chain runtime before starting`);
  assert.ok(heartbeatStart > readiness, `${workerType} heartbeat must start only after chain readiness`);
  if (requiresSigner) {
    const signer = source.indexOf("createRelayerWallet");
    assert.ok(signer > readiness, `${workerType} signer handshake must follow chain readiness`);
    assert.ok(heartbeatStart > signer, `${workerType} heartbeat must start only after signer handshake`);
  }
}

assert.match(heartbeat, /createServiceClient\(env\.SUPABASE_URL, env\.SUPABASE_SERVICE_ROLE_KEY\)/);
assert.match(heartbeat, /RETENTION_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
assert.match(heartbeat, /\.delete\(\)[\s\S]*\.eq\("worker_type", workerType\)[\s\S]*\.lt\("last_heartbeat_at", cutoff\)/);
assert.match(heartbeat, /randomUUID\(\)/);
assert.match(heartbeat, /timer\.unref\(\)/);

const payload = heartbeat.match(/const payload = \{([\s\S]*?)\n      \};/)?.[1];
assert.ok(payload, "heartbeat payload must remain statically inspectable");
for (const allowed of ["instance_id", "worker_type", "status", "chain_id", "build_commit", "started_at", "last_heartbeat_at", "last_success_at", "error_code"]) {
  assert.match(payload, new RegExp(`\\b${allowed}\\b`), `heartbeat payload must include ${allowed}`);
}
for (const forbidden of [
  "job_id",
  "order_id",
  "proof",
  "public_inputs",
  "payload",
  "ciphertext",
  "signature",
  "rpc_url",
  "signer_url",
  "private_key",
  "service_role_key",
]) {
  assert.doesNotMatch(payload, new RegExp(forbidden, "i"), `heartbeat payload must not include ${forbidden}`);
}

assert.match(operations, /Promise\.all\(WORKERS\.map/);
assert.match(operations, /\.eq\("worker_type", type\)[\s\S]*\.order\("last_heartbeat_at"[\s\S]*\.limit\(1\)/);
assert.doesNotMatch(operations, /\.limit\(100\)/, "one noisy worker type must not crowd other worker types out of the operations view");
assert.match(operations, /Liveness is not authority\./);
assert.match(operations, /Use Besu receipts, contract state, ZK verification and indexed canonical events/);
assert.doesNotMatch(healthRoute, /worker_runtime_heartbeats|Worker liveness|worker_type/, "public health endpoint must not expose internal worker topology");

assert.match(migration, /alter table public\.worker_runtime_heartbeats enable row level security/);
assert.match(migration, /revoke all on table public\.worker_runtime_heartbeats from anon, authenticated/);
assert.match(migration, /grant select on table public\.worker_runtime_heartbeats to authenticated/);
assert.match(migration, /grant all on table public\.worker_runtime_heartbeats to service_role/);
assert.match(migration, /worker_runtime_heartbeats_consortium_read/);
assert.match(migration, /m\.user_id = \(select auth\.uid\(\)\)[\s\S]*m\.active/);

const tableDefinition = migration.match(/create table public\.worker_runtime_heartbeats \(([\s\S]*?)\n\);/)?.[1];
assert.ok(tableDefinition, "heartbeat table definition must remain inspectable");
for (const forbidden of ["job_id", "order_id", "transaction_hash", "payload", "ciphertext", "signature", "rpc", "signer", "private_key", "error_detail"]) {
  assert.doesNotMatch(tableDefinition, new RegExp(forbidden, "i"), `heartbeat table must not persist ${forbidden}`);
}

console.log(JSON.stringify({
  threadproof_runtime_observability_tests: "PASS",
  worker_types: workers.map(([workerType]) => workerType),
  authority_boundary: "liveness telemetry is advisory; canonical protocol state remains on-chain/indexed",
}));
