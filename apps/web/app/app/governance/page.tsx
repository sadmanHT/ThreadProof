import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const { data: proposals } = await supabase.from("governance_proposal_read_model").select("*").order("updated_at", { ascending: false });
  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">THREADPROOF CHARTER</span><h1>Governance</h1><p>Consensus orders valid transactions; the Charter determines who is authorized to exercise exceptional protocol powers.</p></div></header><section className="card-grid">{(proposals ?? []).map((proposal) => <article className="entity-card" key={proposal.chain_proposal_id}><div className="entity-card-top"><div><span className="kicker">{titleCase(proposal.proposal_type)}</span><h2>{shortHash(proposal.chain_proposal_id, 12, 8)}</h2></div><StatusBadge value={proposal.state} /></div><dl className="definition-grid"><div><dt>Approvals</dt><dd>{proposal.approvals_received} / {proposal.approvals_required ?? "—"}</dd></div><div><dt>Policy version</dt><dd>{proposal.policy_version ?? "—"}</dd></div><div><dt>Execute after</dt><dd>{formatDate(proposal.execute_after, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Last synced block</dt><dd>{proposal.last_synced_block}</dd></div></dl></article>)}{!(proposals ?? []).length ? <div className="empty-state large full-span"><strong>No governance proposals indexed</strong><span>Governance state is a read model of Charter events; approvals and execution occur on-chain.</span></div> : null}</section></div>;
}
