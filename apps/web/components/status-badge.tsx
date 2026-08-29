import { titleCase } from "@/lib/format";

const positive = new Set(["active", "accepted", "completed", "confirmed", "generated", "feasible", "executed"]);
const negative = new Set(["revoked", "failed", "infeasible", "cancelled", "rejected", "suspended", "stale"]);
const warning = new Set(["pending", "queued", "generating", "submitted", "pending_spend", "recertification_required", "proposed"]);

export function StatusBadge({ value }: { value: string }) {
  const tone = positive.has(value) ? "success" : negative.has(value) ? "danger" : warning.has(value) ? "warning" : "neutral";
  return <span className={`badge ${tone}`}>{titleCase(value)}</span>;
}
