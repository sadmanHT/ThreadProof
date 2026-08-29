import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: credentials }, { data: organizations }] = await Promise.all([
    supabase.from("credentials").select("id,chain_credential_id,subject_organization_id,issuer_organization_id,credential_type,digest,scope_hash,status,valid_from,valid_until,chain_tx_hash,created_at").order("created_at", { ascending: false }),
    supabase.from("organizations").select("id,display_name,role"),
  ]);
  const orgMap = new Map((organizations ?? []).map((org) => [org.id, org]));

  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">VERIFIABLE CREDENTIALS</span><h1>Credential registry</h1><p>Consortium-visible metadata mirrors credential status. Issuance, suspension and revocation authority comes from the chain.</p></div></header><section className="panel table-panel">{(credentials ?? []).length ? <div className="data-table credential-table"><div className="table-row table-head"><span>Credential</span><span>Subject</span><span>Issuer</span><span>Status</span><span>Validity</span></div>{(credentials ?? []).map((credential) => <div className="table-row" key={credential.id}><span><strong>{titleCase(credential.credential_type)}</strong><small className="mono">{shortHash(credential.chain_credential_id)}</small></span><span>{orgMap.get(credential.subject_organization_id)?.display_name ?? "Unknown"}</span><span>{orgMap.get(credential.issuer_organization_id)?.display_name ?? "Unknown"}</span><span><StatusBadge value={credential.status} /></span><span><strong>{formatDate(credential.valid_until)}</strong><small>from {formatDate(credential.valid_from)}</small></span></div>)}</div> : <div className="empty-state large"><strong>No credentials indexed yet</strong><span>Credential records appear here only after authorized issuers anchor them to CredentialRegistry and the indexer observes the event.</span></div>}</section><p className="footnote">ThreadProof can prove who issued a credential and whether it is still active. It does not cryptographically prove that the auditor’s original physical-world assessment was correct.</p></div>;
}
