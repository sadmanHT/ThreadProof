import { CircleAlert, CircleCheck, CircleDot, CircleX } from "lucide-react";
import { titleCase } from "@/lib/format";

const positive = new Set(["active", "accepted", "completed", "confirmed", "generated", "feasible", "executed"]);
const negative = new Set(["revoked", "failed", "infeasible", "cancelled", "rejected", "suspended", "stale"]);
const warning = new Set(["pending", "queued", "generating", "prepared", "signed", "submitting", "submitted", "pending_spend", "recertification_required", "proposed", "timelocked", "reconciling"]);

export function StatusBadge({ value }: { value: string }) {
  const tone = positive.has(value) ? "success" : negative.has(value) ? "danger" : warning.has(value) ? "warning" : "neutral";
  const Icon = tone === "success" ? CircleCheck : tone === "danger" ? CircleX : tone === "warning" ? CircleAlert : CircleDot;
  return <span className={`badge ${tone} premium-status-badge`}><Icon size={12} strokeWidth={2} aria-hidden="true" />{titleCase(value)}</span>;
}
