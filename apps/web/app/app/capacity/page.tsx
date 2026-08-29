import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function CapacityPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: openings }, { data: organizations }] = await Promise.all([
    supabase.from("private_capacity_openings").select("id,factory_organization_id,capacity_credential_id,period_id,process_id,chain_state_key,policy_hash,circuit_version,status,last_chain_block,updated_at").order("updated_at", { ascending: false }),
    supabase.from("organizations").select("id,display_name"),
  ]);
  const orgMap = new Map((organizations ?? []).map((org) => [org.id, org.display_name]));

  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">PRIVATE WITNESS STATE</span><h1>Capacity states</h1><p>Factories can inspect commitment metadata without exposing remaining capacity or randomness. The chain—not this table—decides which commitment is current.</p></div></header><section className="privacy-banner"><span className="privacy-icon">◌</span><div><strong>Exact capacity is intentionally absent from this screen.</strong><p>Remaining capacity and opening randomness stay encrypted and are consumed only by the proof worker.</p></div></section><section className="card-grid">{(openings ?? []).map((opening) => <article className="entity-card" key={opening.id}><div className="entity-card-top"><div><span className="kicker">{orgMap.get(opening.factory_organization_id) ?? "Factory"}</span><h2>{opening.period_id} · {titleCase(opening.process_id)}</h2></div><StatusBadge value={opening.status} /></div><dl className="definition-grid"><div><dt>State key</dt><dd className="mono">{shortHash(opening.chain_state_key)}</dd></div><div><dt>Policy</dt><dd className="mono">{shortHash(opening.policy_hash)}</dd></div><div><dt>Circuit</dt><dd>v{opening.circuit_version}</dd></div><div><dt>Last chain block</dt><dd>{opening.last_chain_block ?? "Not indexed"}</dd></div><div><dt>Mirror updated</dt><dd>{formatDate(opening.updated_at)}</dd></div></dl></article>)}{!(openings ?? []).length ? <div className="empty-state large full-span"><strong>No private capacity states visible</strong><span>Only members of the owning factory can read encrypted capacity openings.</span></div> : null}</section></div>;
}
