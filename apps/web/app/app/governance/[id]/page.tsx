import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function projectedState(proposal: { state: string; execute_after: string | null; expires_at: string | null }) {
  const now = Date.now();
  if (proposal.state === "timelocked" && proposal.execute_after && Date.parse(proposal.execute_after) <= now) return "executable";
  if (proposal.state === "pending" && proposal.expires_at && Date.parse(proposal.expires_at) < now) return "expired";
  return proposal.state;
}

function progressRank(state: string) {
  if (state === "executed") return 3;
  if (state === "executable") return 2;
  if (state === "timelocked") return 1;
  return 0;
}

export default async function GovernanceProposalPage({ params }: Props) {
  await requireConsortiumViewer();
  const { id } = await params;
  if (!HEX_32.test(id)) notFound();
  const supabase = await createClient();
  const { data: proposal } = await supabase.from("governance_proposal_read_model").select("*").eq("chain_proposal_id", id).maybeSingle();
  if (!proposal) notFound();

  const [{ data: proposer }, { data: events }] = await Promise.all([
    supabase.from("organizations").select("display_name,role,status,chain_organization_id").eq("chain_organization_id", proposal.proposer_chain_organization_id).maybeSingle(),
    supabase.from("chain_events").select("id,event_name,transaction_hash,block_number,log_index,observed_at,indexed_values,data").order("block_number", { ascending: false }).order("log_index", { ascending: false }).limit(500),
  ]);
  const needle = id.toLowerCase();
  const relatedEvents = (events ?? []).filter((event) => JSON.stringify([event.indexed_values, event.data]).toLowerCase().includes(needle)).slice(0, 50);
  const state = projectedState(proposal);
  const rank = progressRank(state);
  const exception = state === "cancelled" || state === "expired";
  const progress = [
    ["Proposed", "Action parameters committed on-chain."],
    ["Approved", "Required constituencies satisfy the threshold."],
    ["Executable", "Timelock has elapsed without changing the committed action."],
    ["Executed", "The Charter action was finalized on-chain."],
  ] as const;

  return <div className="workspace-page">
    <div className="breadcrumb-row"><Link href="/app/governance">Governance</Link><span>›</span><span>{shortHash(id, 12, 8)}</span></div>
    <header className="proposal-detail-hero"><div><span className="kicker">{titleCase(proposal.proposal_type)}</span><h1>Proposal evidence</h1><p className="mono" title={id}>{id}</p></div><StatusBadge value={state} /></header>

    {exception ? <div className="alert alert-error">This proposal is {state}. It cannot be treated as executable authority.</div> : null}

    <section className="panel proposal-progress-panel"><div className="panel-heading"><div><span className="kicker">DUE PROCESS</span><h2>Governance progression</h2></div></div><div className="proposal-progress">{progress.map(([label, description], index) => <div className={index < rank ? "complete" : index === rank && !exception ? "active" : ""} key={label}><span>{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><small>{description}</small></div>)}</div></section>

    <section className="detail-grid organization-detail-grid">
      <article className="panel"><div className="panel-heading"><div><span className="kicker">COMMITTED AUTHORITY</span><h2>Proposal parameters</h2></div></div><dl className="definition-grid"><div><dt>State</dt><dd><StatusBadge value={state} /></dd></div><div><dt>Policy version</dt><dd>{proposal.policy_version ?? "—"}</dd></div><div><dt>Approvals</dt><dd>{proposal.approvals_received} / {proposal.approvals_required ?? "—"}</dd></div><div><dt>Approval mask</dt><dd>{proposal.approval_mask}</dd></div><div className="wide"><dt>Action commitment</dt><dd className="mono hash-full">{proposal.action_hash ?? "—"}</dd></div><div className="wide"><dt>Metadata commitment</dt><dd className="mono hash-full">{proposal.metadata_hash ?? "—"}</dd></div><div><dt>Execute after</dt><dd>{formatDate(proposal.execute_after, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Expires</dt><dd>{formatDate(proposal.expires_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Approved</dt><dd>{formatDate(proposal.approved_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Executed</dt><dd>{formatDate(proposal.executed_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div className="wide"><dt>Executed transaction</dt><dd className="mono hash-full">{proposal.executed_tx_hash ?? "—"}</dd></div><div><dt>Last synced block</dt><dd>{proposal.last_synced_block.toLocaleString()}</dd></div></dl></article>

      <article className="panel trust-panel"><span className="kicker">CONSTITUENCY CONTEXT</span><h2>{proposer?.display_name ?? "On-chain proposer"}</h2><p>{proposer ? `${titleCase(proposer.role)} · ${titleCase(proposer.status)}` : "The proposer organization is represented by its canonical chain identifier."}</p><dl className="definition-grid"><div className="wide"><dt>Proposer chain organization</dt><dd className="mono hash-full">{proposal.proposer_chain_organization_id}</dd></div><div><dt>Cancelled</dt><dd>{formatDate(proposal.cancelled_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Read model updated</dt><dd>{formatDate(proposal.updated_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl><div className="privacy-access-list"><span className="privacy-chip consortium">Canonical approvals</span><span className="privacy-chip shared">Committed action parameters</span><span className="privacy-chip private">Protected identity payload stays concealed</span></div></article>
    </section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">RELATED CHAIN EVENTS</span><h2>Proposal audit evidence</h2></div><span className="panel-count">{relatedEvents.length}</span></div>{relatedEvents.length ? <div className="proposal-audit-list">{relatedEvents.map((event) => <div className="proposal-audit-row" key={event.id}><strong>{titleCase(event.event_name)}</strong><span className="mono" title={event.transaction_hash}>{shortHash(event.transaction_hash)}</span><small>block {Number(event.block_number).toLocaleString()} · {formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</small></div>)}</div> : <div className="empty-state"><strong>No matching indexed events in the current audit window</strong><span>The proposal read model remains rebuildable from canonical Charter events; this detail screen does not create governance authority.</span></div>}</section>

    <p className="footnote">For protected-identity disclosure proposals, this view intentionally exposes only commitments, approvals, timing and canonical execution evidence. The encrypted identity mapping remains service-role only.</p>
  </div>;
}
