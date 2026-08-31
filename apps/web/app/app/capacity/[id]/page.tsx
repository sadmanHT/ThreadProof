import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function CapacityDetailPage({ params }: Props) {
  await requireConsortiumViewer();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: opening } = await supabase.from("private_capacity_openings")
    .select("id,factory_organization_id,capacity_credential_id,period_id,process_id,chain_state_key,capacity_commitment,policy_hash,circuit_version,status,last_chain_block,created_at,updated_at,chain_period_id,chain_process_id")
    .eq("id", id)
    .maybeSingle();
  if (!opening) notFound();

  const [{ data: factory }, { data: credential }, { data: proofs }, { data: allocations }] = await Promise.all([
    supabase.from("organizations").select("display_name,legal_name,chain_organization_id,status").eq("id", opening.factory_organization_id).maybeSingle(),
    supabase.from("credentials").select("id,chain_credential_id,credential_type,status,valid_from,valid_until,issuer_organization_id,digest,scope_hash").eq("id", opening.capacity_credential_id).maybeSingle(),
    supabase.from("proof_jobs").select("id,status,circuit_version,order_version_id,created_at,started_at,completed_at,chain_tx_hash,chain_block_number,error_code").eq("capacity_opening_id", opening.id).order("created_at", { ascending: false }).limit(12),
    supabase.from("capacity_allocations").select("id,order_version_id,old_commitment,new_commitment,order_commitment,chain_tx_hash,chain_block_number,confirmed_at,created_at").eq("capacity_opening_id", opening.id).order("created_at", { ascending: false }).limit(12),
  ]);

  return (
    <div className="workspace-page">
      <div className="breadcrumb-row"><Link href="/app/capacity">Capacity</Link><span>›</span><span>{opening.period_id} · {titleCase(opening.process_id)}</span></div>
      <header className="proof-detail-hero"><div><span className="kicker">CAPACITY STATE EVIDENCE</span><h1>{factory?.display_name ?? "Factory"} · {opening.period_id}</h1><p>{titleCase(opening.process_id)} · circuit v{opening.circuit_version}</p></div><StatusBadge value={opening.status} /></header>

      <section className="privacy-banner"><span className="privacy-icon">◌</span><div><strong>The opening is inspectable; the amount is not.</strong><p>This page intentionally excludes encrypted remaining-capacity and randomness fields. The commitment, policy binding, credential provenance and chain reconciliation are visible without revealing the witness.</p></div></section>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">CURRENT MIRROR</span><h2>Capacity commitment state</h2></div></div><dl className="definition-grid"><div className="wide"><dt>Chain state key</dt><dd className="mono hash-full">{opening.chain_state_key}</dd></div><div><dt>Period</dt><dd>{opening.period_id}</dd></div><div><dt>Process</dt><dd>{titleCase(opening.process_id)}</dd></div><div className="wide"><dt>Capacity commitment</dt><dd className="mono hash-full">{opening.capacity_commitment}</dd></div><div className="wide"><dt>Policy hash</dt><dd className="mono hash-full">{opening.policy_hash}</dd></div><div><dt>Circuit</dt><dd>v{opening.circuit_version}</dd></div><div><dt>Last indexed block</dt><dd>{opening.last_chain_block ?? "Not indexed"}</dd></div><div><dt>Mirror created</dt><dd>{formatDate(opening.created_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Mirror updated</dt><dd>{formatDate(opening.updated_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl></article>

        <article className="panel"><div className="panel-heading"><div><span className="kicker">CERTIFICATION</span><h2>Credential provenance</h2></div></div>{credential ? <dl className="definition-grid"><div><dt>Credential type</dt><dd>{titleCase(credential.credential_type)}</dd></div><div><dt>Status</dt><dd><StatusBadge value={credential.status} /></dd></div><div className="wide"><dt>Chain credential id</dt><dd className="mono hash-full">{credential.chain_credential_id}</dd></div><div><dt>Valid from</dt><dd>{formatDate(credential.valid_from)}</dd></div><div><dt>Valid until</dt><dd>{formatDate(credential.valid_until)}</dd></div><div className="wide"><dt>Credential digest</dt><dd className="mono hash-full">{credential.digest}</dd></div><div className="wide"><dt>Scope hash</dt><dd className="mono hash-full">{credential.scope_hash}</dd></div></dl> : <div className="empty-state"><strong>Credential metadata is not visible</strong><span>The opening references a credential id, but this session cannot currently resolve its consortium-visible metadata.</span></div>}{credential ? <Link className="proposal-open-link" href={`/app/credentials/${credential.id}`}>Open credential evidence →</Link> : null}</article>
      </section>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">PROOF ACTIVITY</span><h2>Jobs bound to this opening</h2></div><span className="panel-count">{proofs?.length ?? 0}</span></div>{(proofs ?? []).length ? <div className="record-list">{(proofs ?? []).map((proof) => <Link className="record-row" href={`/app/proofs/${proof.id}`} key={proof.id}><div><strong>Proof {shortHash(proof.id, 8, 6)}</strong><span>circuit v{proof.circuit_version} · created {formatDate(proof.created_at)}{proof.chain_block_number ? ` · block ${proof.chain_block_number}` : ""}</span></div><StatusBadge value={proof.status} /></Link>)}</div> : <div className="empty-state"><strong>No visible proof jobs</strong><span>Proof jobs appear here when this opening is used in a feasible-capacity workflow visible to the current session.</span></div>}</article>

        <article className="panel"><div className="panel-heading"><div><span className="kicker">CONFIRMED TRANSITIONS</span><h2>Indexed allocations</h2></div><span className="panel-count">{allocations?.length ?? 0}</span></div>{(allocations ?? []).length ? <div className="record-list">{(allocations ?? []).map((allocation) => <div className="record-row" key={allocation.id}><div><strong>Transition {shortHash(allocation.id, 8, 6)}</strong><span>old {shortHash(allocation.old_commitment)} → new {shortHash(allocation.new_commitment)} · block {allocation.chain_block_number ?? "not indexed"}</span></div><StatusBadge value={allocation.confirmed_at ? "confirmed" : "submitted"} /></div>)}</div> : <div className="empty-state"><strong>No confirmed transitions indexed</strong><span>An active opening may have no spend yet. A successful proof job alone is not evidence that CapacityVault accepted a transition.</span></div>}</article>
      </section>

      <section className="panel trust-panel"><span className="kicker">AUTHORITY BOUNDARY</span><h2>CapacityVault decides which commitment is current.</h2><p>Supabase stores encrypted witness material and rebuildable reconciliation records so workers and operators can coordinate. Stale application state cannot authorize a second spend, and this page must never be treated as the canonical capacity ledger.</p></section>
    </div>
  );
}
