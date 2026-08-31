import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function CredentialDetailPage({ params }: Props) {
  await requireConsortiumViewer();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const { data: credential } = await supabase.from("credentials").select("*").eq("id", id).maybeSingle();
  if (!credential) notFound();

  const [{ data: subject }, { data: issuer }, { data: openings }] = await Promise.all([
    supabase.from("organizations").select("id,display_name,legal_name,role,status,chain_organization_id").eq("id", credential.subject_organization_id).maybeSingle(),
    supabase.from("organizations").select("id,display_name,legal_name,role,status,chain_organization_id").eq("id", credential.issuer_organization_id).maybeSingle(),
    supabase.from("private_capacity_openings").select("id,period_id,process_id,chain_state_key,status,circuit_version,last_chain_block,updated_at").eq("capacity_credential_id", credential.id).order("updated_at", { ascending: false }).limit(8),
  ]);

  const expired = Date.parse(credential.valid_until) < Date.now();
  const effectiveStatus = credential.status === "active" && expired ? "expired" : credential.status;

  return (
    <div className="workspace-page">
      <div className="breadcrumb-row"><Link href="/app/credentials">Credentials</Link><span>›</span><span>{shortHash(credential.chain_credential_id, 10, 8)}</span></div>
      <header className="proof-detail-hero"><div><span className="kicker">CREDENTIAL EVIDENCE</span><h1>{titleCase(credential.credential_type)}</h1><p>{subject?.display_name ?? "Unknown subject"} · issued by {issuer?.display_name ?? "Unknown issuer"}</p></div><StatusBadge value={effectiveStatus} /></header>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">AUTHORIZATION RECORD</span><h2>Registry-bound metadata</h2></div></div><dl className="definition-grid"><div className="wide"><dt>Chain credential id</dt><dd className="mono hash-full">{credential.chain_credential_id}</dd></div><div><dt>Subject</dt><dd>{subject?.display_name ?? "Unknown"}</dd></div><div><dt>Subject role</dt><dd>{subject ? titleCase(subject.role) : "—"}</dd></div><div><dt>Issuer</dt><dd>{issuer?.display_name ?? "Unknown"}</dd></div><div><dt>Issuer role</dt><dd>{issuer ? titleCase(issuer.role) : "—"}</dd></div><div className="wide"><dt>Credential digest</dt><dd className="mono hash-full">{credential.digest}</dd></div><div className="wide"><dt>Scope hash</dt><dd className="mono hash-full">{credential.scope_hash}</dd></div><div><dt>Valid from</dt><dd>{formatDate(credential.valid_from, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Valid until</dt><dd>{formatDate(credential.valid_until, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div className="wide"><dt>Issuance transaction</dt><dd className="mono hash-full">{credential.chain_tx_hash ?? "Not indexed"}</dd></div></dl></article>

        <article className="panel trust-panel"><span className="kicker">WHAT THIS PROVES</span><h2>Digital authority, not physical truth.</h2><p>ThreadProof can establish who issued this credential, its committed scope, its validity window and whether its on-chain authorization remains usable. It does not prove that the underlying physical inspection or assessment was factually correct.</p><div className="privacy-access-list"><span className="privacy-chip shared">Digest verifiable</span><span className="privacy-chip consortium">Lifecycle attributable</span><span className="privacy-chip private">Encrypted body concealed</span></div></article>
      </section>

      <section className="proof-evidence-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">PARTIES</span><h2>Consortium attribution</h2></div></div><dl className="definition-grid"><div><dt>Subject legal name</dt><dd>{subject?.legal_name ?? "Not visible"}</dd></div><div><dt>Subject status</dt><dd>{subject ? <StatusBadge value={subject.status} /> : "—"}</dd></div><div className="wide"><dt>Subject chain organization</dt><dd className="mono hash-full">{subject?.chain_organization_id ?? "Not visible"}</dd></div><div><dt>Issuer legal name</dt><dd>{issuer?.legal_name ?? "Not visible"}</dd></div><div><dt>Issuer status</dt><dd>{issuer ? <StatusBadge value={issuer.status} /> : "—"}</dd></div><div className="wide"><dt>Issuer chain organization</dt><dd className="mono hash-full">{issuer?.chain_organization_id ?? "Not visible"}</dd></div></dl></article>

        <article className="panel"><div className="panel-heading"><div><span className="kicker">CAPACITY LINKAGE</span><h2>Visible capacity states</h2></div><span className="panel-count">{openings?.length ?? 0}</span></div>{(openings ?? []).length ? <div className="record-list">{(openings ?? []).map((opening) => <div className="record-row" key={opening.id}><div><strong>{opening.period_id} · {titleCase(opening.process_id)}</strong><span>circuit v{opening.circuit_version} · block {opening.last_chain_block ?? "not indexed"} · {formatDate(opening.updated_at)}</span></div><StatusBadge value={opening.status} /></div>)}</div> : <div className="empty-state"><strong>No capacity opening is visible to this session</strong><span>That can mean this credential is not a capacity credential, or the current viewer is not authorized to read the factory-confidential opening table.</span></div>}</article>
      </section>

      <p className="footnote">The credential row and any visible capacity opening are application read models. Critical authorization must still be checked against CredentialRegistry and the current CapacityVault state.</p>
    </div>
  );
}
