import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { CapacityCertificationForm } from "@/components/capacity-certification-form";

export const dynamic = "force-dynamic";
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

export default async function CapacityPage() {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const activeOrganizationId = active?.organization_id ?? EMPTY_UUID;
  const activeRole = active?.organization.role;
  const supabase = await createClient();

  const openingsBase = supabase.from("private_capacity_openings").select("id,factory_organization_id,capacity_credential_id,period_id,process_id,chain_state_key,policy_hash,circuit_version,status,last_chain_block,updated_at").order("updated_at", { ascending: false });
  const certificationBase = supabase.from("capacity_certification_jobs").select("id,factory_organization_id,auditor_organization_id,period_label,process_label,policy_hash,capacity_commitment,circuit_version,status,credential_tx_hash,certification_tx_hash,created_at,updated_at").order("created_at", { ascending: false }).limit(40);

  const [{ data: openings }, { data: organizations }, { data: certificationJobs }] = await Promise.all([
    activeRole === "factory" ? openingsBase.eq("factory_organization_id", activeOrganizationId) : openingsBase.eq("id", EMPTY_UUID),
    supabase.from("organizations").select("id,display_name,role,status").order("display_name"),
    activeRole === "auditor" ? certificationBase.eq("auditor_organization_id", activeOrganizationId) : certificationBase.eq("id", EMPTY_UUID),
  ]);

  const orgMap = new Map((organizations ?? []).map((org) => [org.id, org.display_name]));
  const auditorMemberships = active && active.organization.role === "auditor" && active.organization.status === "active" && hasOperationalRole(active)
    ? [active]
    : [];
  const factories = (organizations ?? [])
    .filter((organization) => organization.role === "factory" && organization.status === "active")
    .map((organization) => ({ id: organization.id, displayName: organization.display_name }));
  const resumableJobs = (certificationJobs ?? [])
    .filter((job) => ["prepared", "credential_confirmed"].includes(job.status))
    .map((job) => ({
      id: job.id,
      status: job.status,
      factoryName: orgMap.get(job.factory_organization_id) ?? "Factory",
      periodLabel: job.period_label,
      processLabel: job.process_label,
    }));

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">CONFIDENTIAL CAPACITY</span><h1>Capacity states</h1><p>{activeRole === "factory" ? `Showing private capacity states owned by ${active?.organization.display_name}.` : activeRole === "auditor" ? `Showing certification work issued by ${active?.organization.display_name}.` : "Switch to a factory or auditor organization to enter an operational capacity context."} Besu decides which commitment is current; Supabase remains encrypted coordination and a rebuildable read model.</p></div></header>

      {auditorMemberships.length ? (
        <CapacityCertificationForm
          auditorOrganizations={auditorMemberships.map((membership) => ({ id: membership.organization_id, displayName: membership.organization.display_name }))}
          factories={factories}
          resumableJobs={resumableJobs}
        />
      ) : null}

      {activeRole === "auditor" && (certificationJobs ?? []).length ? <section className="panel"><div className="panel-heading"><div><span className="kicker">AUDITOR WORKFLOW</span><h2>Certification reconciliation</h2></div></div><div className="record-list">{(certificationJobs ?? []).map((job) => <div className="record-row" key={job.id}><div><strong>{orgMap.get(job.factory_organization_id) ?? "Factory"} · {job.period_label} · {titleCase(job.process_label)}</strong><span>Commitment <span className="mono">{shortHash(job.capacity_commitment)}</span> · policy <span className="mono">{shortHash(job.policy_hash)}</span> · updated {formatDate(job.updated_at)}</span></div><StatusBadge value={job.status} /></div>)}</div></section> : null}

      <section className="privacy-banner"><span className="privacy-icon">◌</span><div><strong>Exact capacity is intentionally absent from this screen.</strong><p>Remaining capacity and opening randomness stay encrypted and are consumed only by the proof worker. Organization switching changes application context; it never makes private witness material visible to another role.</p></div></section>

      {activeRole === "factory" ? <section className="card-grid">
        {(openings ?? []).map((opening) => <Link className="entity-card entity-card-link" href={`/app/capacity/${opening.id}`} key={opening.id}><div className="entity-card-top"><div><span className="kicker">{orgMap.get(opening.factory_organization_id) ?? "Factory"}</span><h2>{opening.period_id} · {titleCase(opening.process_id)}</h2></div><StatusBadge value={opening.status} /></div><dl className="definition-grid"><div><dt>State key</dt><dd className="mono">{shortHash(opening.chain_state_key)}</dd></div><div><dt>Policy</dt><dd className="mono">{shortHash(opening.policy_hash)}</dd></div><div><dt>Circuit</dt><dd>v{opening.circuit_version}</dd></div><div><dt>Last chain block</dt><dd>{opening.last_chain_block ?? "Not indexed"}</dd></div><div><dt>Mirror updated</dt><dd>{formatDate(opening.updated_at)}</dd></div></dl><span className="proposal-open-link">Open capacity evidence →</span></Link>)}
        {!(openings ?? []).length ? <div className="empty-state large full-span"><strong>No capacity openings in this factory context</strong><span>A matching CapacityCertified event must reconcile before a private opening appears for the selected factory.</span></div> : null}
      </section> : null}

      {activeRole !== "factory" && activeRole !== "auditor" ? <div className="empty-state large"><strong>No capacity operations for this organization role</strong><span>Switch to a factory to inspect private capacity states or to an auditor to manage certification reconciliation.</span></div> : null}
    </div>
  );
}
