import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import type { Tables } from "@/lib/database.types";

export const dynamic = "force-dynamic";

type Heartbeat = Tables<"worker_runtime_heartbeats">;

type WorkerType =
  | "indexer"
  | "order_relayer"
  | "subcontract_relayer"
  | "proof_generator"
  | "proof_submitter";

const WORKERS: readonly { type: WorkerType; label: string; responsibility: string }[] = [
  { type: "indexer", label: "Chain indexer", responsibility: "Rebuilds confirmation-adjusted read models from canonical protocol events." },
  { type: "order_relayer", label: "Order relayer", responsibility: "Relays buyer-signed order versions and cancellations without owning buyer authority." },
  { type: "subcontract_relayer", label: "Subcontract relayer", responsibility: "Relays parent-factory EIP-712 subcontract authorizations after live preflight." },
  { type: "proof_generator", label: "Proof generator", responsibility: "Generates Groth16 proofs inside the private factory witness boundary." },
  { type: "proof_submitter", label: "Proof submitter", responsibility: "Submits generated PoFC proofs through the configured transaction signer boundary." },
] as const;

function configuredHeartbeatMs() {
  const candidate = Number(process.env.THREADPROOF_WORKER_HEARTBEAT_INTERVAL_MS ?? "20000");
  return Number.isSafeInteger(candidate) && candidate >= 5_000 && candidate <= 300_000 ? candidate : 20_000;
}

function heartbeatState(heartbeat: Heartbeat | null, now: number, staleAfterMs: number) {
  if (!heartbeat) return "missing" as const;
  const age = now - Date.parse(heartbeat.last_heartbeat_at);
  if (!Number.isFinite(age) || age < 0 || age > staleAfterMs) return "stale" as const;
  if (heartbeat.status === "degraded") return "degraded" as const;
  if (heartbeat.status === "stopping") return "stopping" as const;
  return "healthy" as const;
}

function ageLabel(timestamp: string | null, now: number) {
  if (!timestamp) return "never";
  const ageMs = Math.max(0, now - Date.parse(timestamp));
  if (!Number.isFinite(ageMs)) return "unknown";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortInstance(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export default async function OperationsPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const now = Date.now();
  const heartbeatMs = configuredHeartbeatMs();
  const staleAfterMs = Math.max(60_000, Math.ceil(heartbeatMs * 4.5));

  const [{ data: heartbeats, error: heartbeatError }, { data: indexerHealth }, chain] = await Promise.all([
    supabase
      .from("worker_runtime_heartbeats")
      .select("instance_id,worker_type,status,chain_id,build_commit,started_at,last_heartbeat_at,last_success_at,error_code")
      .order("last_heartbeat_at", { ascending: false })
      .limit(100),
    supabase.rpc("get_chain_indexer_health"),
    getBlockchainStatus(),
  ]);

  const freshestByType = new Map<WorkerType, Heartbeat>();
  for (const heartbeat of heartbeats ?? []) {
    const workerType = heartbeat.worker_type as WorkerType;
    if (WORKERS.some((worker) => worker.type === workerType) && !freshestByType.has(workerType)) {
      freshestByType.set(workerType, heartbeat);
    }
  }

  const rows = WORKERS.map((worker) => {
    const heartbeat = freshestByType.get(worker.type) ?? null;
    return { worker, heartbeat, state: heartbeatState(heartbeat, now, staleAfterMs) };
  });
  const healthyCount = rows.filter((row) => row.state === "healthy").length;
  const staleCount = rows.filter((row) => row.state === "stale").length;
  const missingCount = rows.filter((row) => row.state === "missing").length;
  const degradedCount = rows.filter((row) => row.state === "degraded" || row.state === "stopping").length;
  const cursor = indexerHealth?.[0] ?? null;
  const indexerLag = chain.online && cursor ? Math.max(0, chain.blockNumber - cursor.last_block_number) : null;

  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <span className="kicker">RUNTIME OPERATIONS</span>
          <h1>Worker liveness</h1>
          <p>Observe whether ThreadProof's execution processes are alive without confusing process telemetry with canonical protocol state.</p>
        </div>
        <div className="page-header-actions">
          <Link className="button secondary" href="/app/chain">Open canonical network</Link>
          <Link className="button secondary" href="/app/audit">Open audit trail</Link>
        </div>
      </header>

      {heartbeatError ? <div className="alert alert-error">Worker liveness telemetry could not be read. Protocol state must still be verified through the canonical network views.</div> : null}

      <section className="subcontract-principles">
        <article><span>Healthy workers</span><strong>{healthyCount} / {WORKERS.length}</strong><small>fresh process self-reports</small></article>
        <article><span>Stale / missing</span><strong>{staleCount + missingCount}</strong><small>{staleCount} stale · {missingCount} never observed</small></article>
        <article><span>Degraded / stopping</span><strong>{degradedCount}</strong><small>explicit runtime status</small></article>
        <article><span>Freshness window</span><strong>{Math.round(staleAfterMs / 1000)} seconds</strong><small>multiple missed heartbeats required</small></article>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">TRUST SEPARATION</span><h2>Canonical state vs process availability</h2></div></div>
        <div className="detail-grid">
          <article>
            <span className="kicker">BESU</span>
            <h3>{chain.online ? "Canonical RPC reachable" : "Canonical RPC unavailable"}</h3>
            <p>{chain.online ? `Chain ${chain.chainId} · head block ${chain.blockNumber.toLocaleString()}.` : "Worker heartbeats cannot make protocol state valid while the canonical chain is unavailable."}</p>
            <StatusBadge value={chain.online ? "online" : "offline"} />
          </article>
          <article>
            <span className="kicker">INDEXER CURSOR</span>
            <h3>{cursor ? `Block ${cursor.last_block_number.toLocaleString()}` : "Cursor unavailable"}</h3>
            <p>{cursor ? `${titleCase(cursor.status)} · ${indexerLag === null ? "lag unknown" : `${indexerLag.toLocaleString()} block lag`}.` : "The read-model cursor is separate from the indexer process heartbeat."}</p>
            <StatusBadge value={cursor?.status ?? "unknown"} />
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="kicker">EXECUTION PLANE</span><h2>Critical worker processes</h2></div><span className="panel-count">{WORKERS.length}</span></div>
        <div className="record-list">
          {rows.map(({ worker, heartbeat, state }) => (
            <article className="record-row" key={worker.type}>
              <div>
                <strong>{worker.label}</strong>
                <span>{worker.responsibility}</span>
                {heartbeat ? <small>Instance <span className="mono">{shortInstance(heartbeat.instance_id)}</span> · started {formatDate(heartbeat.started_at, { dateStyle: "medium", timeStyle: "short" })}</small> : <small>No runtime instance has reported through the current telemetry table.</small>}
              </div>
              <div className="record-row-meta">
                <StatusBadge value={state} />
                <span>{heartbeat ? ageLabel(heartbeat.last_heartbeat_at, now) : "no heartbeat"}</span>
                <small>{heartbeat?.chain_id ? `chain ${heartbeat.chain_id}` : "chain unavailable"}{heartbeat?.build_commit ? ` · build ${heartbeat.build_commit.slice(0, 12)}` : ""}</small>
                {heartbeat?.error_code ? <small className="mono">{heartbeat.error_code}</small> : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="privacy-banner">
        <span className="privacy-icon">i</span>
        <div><strong>Liveness is not authority.</strong><p>A healthy heartbeat only means a process recently self-reported after startup readiness checks. It does not prove a transaction, proof, credential, order, capacity state, or subcontract is valid. Use Besu receipts, contract state, ZK verification and indexed canonical events for those decisions.</p></div>
      </section>
    </div>
  );
}
