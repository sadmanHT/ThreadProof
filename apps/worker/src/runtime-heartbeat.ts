import { randomUUID } from "node:crypto";
import { createServiceClient } from "./supabase.js";

export const WORKER_RUNTIME_TYPES = [
  "indexer",
  "order_relayer",
  "subcontract_relayer",
  "proof_generator",
  "proof_submitter",
] as const;

export type WorkerRuntimeType = (typeof WORKER_RUNTIME_TYPES)[number];

const DEFAULT_HEARTBEAT_MS = 20_000;
const MIN_HEARTBEAT_MS = 5_000;
const MAX_HEARTBEAT_MS = 300_000;

function heartbeatIntervalMs() {
  const raw = process.env.THREADPROOF_WORKER_HEARTBEAT_INTERVAL_MS;
  if (!raw) return DEFAULT_HEARTBEAT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_HEARTBEAT_MS || parsed > MAX_HEARTBEAT_MS) {
    throw new Error(`THREADPROOF_WORKER_HEARTBEAT_INTERVAL_MS must be between ${MIN_HEARTBEAT_MS} and ${MAX_HEARTBEAT_MS}.`);
  }
  return parsed;
}

function buildCommit() {
  const value = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? process.env.RENDER_GIT_COMMIT ?? null;
  return value ? value.slice(0, 64) : null;
}

export async function startWorkerRuntimeHeartbeat(workerType: WorkerRuntimeType, chainId: number) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Worker heartbeat requires a positive canonical chain id.");

  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const intervalMs = heartbeatIntervalMs();
  const supabase = createServiceClient();
  let writing = false;
  let registered = false;

  async function writeHeartbeat() {
    if (writing) return;
    writing = true;
    const now = new Date().toISOString();
    try {
      const payload = {
        instance_id: instanceId,
        worker_type: workerType,
        status: "ready",
        chain_id: chainId,
        build_commit: buildCommit(),
        started_at: startedAt,
        last_heartbeat_at: now,
        last_success_at: now,
        error_code: null,
      };
      const query = registered
        ? supabase.from("worker_runtime_heartbeats").update({
            status: payload.status,
            chain_id: payload.chain_id,
            build_commit: payload.build_commit,
            last_heartbeat_at: payload.last_heartbeat_at,
            last_success_at: payload.last_success_at,
            error_code: null,
          }).eq("instance_id", instanceId)
        : supabase.from("worker_runtime_heartbeats").upsert(payload, { onConflict: "instance_id" });
      const { error } = await query;
      if (error) {
        console.error(`ThreadProof ${workerType} heartbeat write failed with code ${error.code ?? "UNKNOWN"}.`);
        return;
      }
      registered = true;
    } catch {
      console.error(`ThreadProof ${workerType} heartbeat write failed.`);
    } finally {
      writing = false;
    }
  }

  await writeHeartbeat();
  const timer = setInterval(() => void writeHeartbeat(), intervalMs);
  timer.unref();

  return {
    instanceId,
    stop() {
      clearInterval(timer);
    },
  };
}
