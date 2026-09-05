import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { queueProofAction } from "@/app/app/actions";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const lifecycle = ["queued", "generating", "generated", "submitted", "confirmed"] as const;
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

function stageIndex(status: string) {
  const index = lifecycle.indexOf(status as (typeof lifecycle)[number]);
  return index < 0 ? -1 : index;
}

export default async function ProofsPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const activeOrganizationId = active?.organization_id ?? EMPTY_UUID;
  const activeRole = active?.organization.role;
  const supabase = await createClient();

  const ordersBase = supabase.from("purchase_orders").select("id,external_reference,title,factory_organization_id,buyer_organization_id,status,current_version");
  const { data: orders } = await (activeRole === "buyer"
    ? ordersBase.eq("buyer_organization_id", activeOrganizationId)
    : activeRole === "factory"
      ? ordersBase.eq("factory_organization_id", activeOrganizationId)
      : ordersBase.eq("id", EMPTY_UUID));
  const orderIds = (orders ?? []).map((order) => order.id);

  const { data: versions } = await supabase.from("order_versions")
    .select("id,purchase_order_id,version,order_commitment,created_at")
    .in("purchase_order_id", orderIds.length ? orderIds : [EMPTY_UUID])
    .order("created_at", { ascending: false });
  const versionIds = (versions ?? []).map((version) => version.id);

  const jobsBase = supabase.from("proof_jobs").select("id,factory_organization_id,order_version_id,capacity_opening_id,status,circuit_version,error_code,error_detail,started_at,completed_at,created_at").order("created_at", { ascending: false });
  const openingsBase = supabase.from("private_capacity_openings").select("id,factory_organization_id,period_id,process_id,status,circuit_version,chain_state_key").order("updated_at", { ascending: false });
  const [{ data: jobs }, { data: openings }] = await Promise.all([
    activeRole === "factory"
      ? jobsBase.eq("factory_organization_id", activeOrganizationId)
      : activeRole === "buyer"
        ? jobsBase.in("order_version_id", versionIds.length ? versionIds : [EMPTY_UUID])
        : jobsBase.eq("id", EMPTY_UUID),
    activeRole === "factory" ? openingsBase.eq("factory_organization_id", activeOrganizationId) : openingsBase.eq("id", EMPTY_UUID),
  ]);

  const versionMap = new Map((versions ?? []).map((version) => [version.id, version]));
  const orderMap = new Map((orders ?? []).map((order) => [order.id, order]));
  const openingMap = new Map((openings ?? []).map((opening) => [opening.id, opening]));
  const activeOpenings = (openings ?? []).filter((opening) => opening.status === "active");
  const canQueue = !!active && active.organization.role === "factory" && hasOperationalRole(active) && (versions ?? []).length > 0 && activeOpenings.length > 0;
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  const rows = jobs ?? [];
  const activeJobs = rows.filter((job) => ["queued", "generating", "generated", "submitted"].includes(job.status)).length;
  const confirmedJobs = rows.filter((job) => job.status === "confirmed").length;
  const attentionJobs = rows.filter((job) => job.status === "failed" || job.status === "stale").length;

  return <div className="workspace-page">
    <header className="page-header"><div><span className="kicker">PROOF-OF-FEASIBLE-CAPACITY</span><h1>Proof jobs</h1><p>{activeRole === "factory" ? `Factory execution for ${active?.organization.display_name}.` : activeRole === "buyer" ? `Buyer-visible feasibility evidence for ${active?.organization.display_name}.` : "Switch to a buyer or factory organization to enter a proof workflow context."} Only a valid proof accepted against the current CapacityVault state can advance canonical capacity.</p></div></header>
    {message ? <div className="alert alert-success">{message}</div> : null}
    {error ? <div className="alert alert-error">{error}</div> : null}

    <section className="proof-overview-grid">
      <article><span>Context jobs</span><strong>{rows.length}</strong><small>{activeRole === "factory" ? "factory execution history" : activeRole === "buyer" ? "buyer relationship evidence" : "no proof role"}</small></article>
      <article><span>In progress</span><strong>{activeJobs}</strong><small>queued through submitted</small></article>
      <article><span>Confirmed</span><strong>{confirmedJobs}</strong><small>accepted capacity transitions</small></article>
      <article className={attentionJobs ? "attention" : undefined}><span>Needs attention</span><strong>{attentionJobs}</strong><small>failed or stale jobs</small></article>
    </section>

    <section className="panel proof-lifecycle-panel">
      <div className="panel-heading"><div><span className="kicker">PROTOCOL LIFECYCLE</span><h2>From private witness to canonical transition</h2></div></div>
      <div className="proof-lifecycle" aria-label="Proof job lifecycle">
        {lifecycle.map((stage, index) => <div key={stage}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage === "confirmed" ? "Confirmed" : stage[0]?.toUpperCase() + stage.slice(1)}</strong><small>{[
          "Job binds an authorized order version to an active private opening.",
          "The worker reconstructs private witness material and generates the circuit witness.",
          "Groth16 proof and public inputs exist, but no shared state has changed yet.",
          "The proof transaction has been relayed to CapacityVault and awaits canonical inclusion.",
          "CapacityVault accepted the proof; the old state is consumed and the successor is canonical.",
        ][index]}</small>{index < lifecycle.length - 1 ? <i aria-hidden="true">→</i> : null}</div>)}
      </div>
      <p className="form-help">Failed and stale jobs sit outside the success rail. They never imply feasibility and never advance capacity.</p>
    </section>

    {canQueue ? <section className="panel form-panel proof-queue-panel"><div className="panel-heading"><div><span className="kicker">FACTORY ACTION</span><h2>Queue feasibility proof</h2></div><span className="privacy-chip private">Private witness remains factory-scoped</span></div><form className="inline-form proof-queue" action={queueProofAction}><label>Authorized order version<select name="orderVersionId" required defaultValue=""><option value="" disabled>Select version</option>{(versions ?? []).map((version) => { const order = orderMap.get(version.purchase_order_id); return order ? <option key={version.id} value={version.id}>{order.external_reference} · v{version.version} · {shortHash(version.order_commitment)}</option> : null; })}</select></label><label>Active capacity state<select name="capacityOpeningId" required defaultValue=""><option value="" disabled>Select state</option>{activeOpenings.map((opening) => <option key={opening.id} value={opening.id}>{opening.period_id} · {opening.process_id} · circuit v{opening.circuit_version}</option>)}</select></label><PendingSubmitButton className="button primary" pendingLabel="Queueing proof…">Queue proof</PendingSubmitButton></form><p className="form-help">The application checks both inputs against the active factory before calling the RPC. The RPC, RLS and CapacityVault still enforce the real authorization and state transition.</p></section> : null}

    <section className="panel proof-history-panel"><div className="panel-heading"><div><span className="kicker">JOB HISTORY</span><h2>Proof execution states</h2></div><span className="panel-count">{rows.length}</span></div>
      {rows.length ? <div className="proof-job-list">{rows.map((job) => {
        const version = versionMap.get(job.order_version_id);
        const order = version ? orderMap.get(version.purchase_order_id) : null;
        const opening = openingMap.get(job.capacity_opening_id);
        const currentStage = stageIndex(job.status);
        const exception = job.status === "failed" || job.status === "stale";
        return <article className={`proof-job-card ${exception ? "exception" : ""}`} key={job.id}>
          <div className="proof-job-main"><div><span className="kicker">{opening ? `${opening.period_id} · ${opening.process_id}` : activeRole === "buyer" ? "PRIVATE FACTORY CAPACITY" : "CAPACITY CONTEXT"}</span><h3>{order?.title || order?.external_reference || "Order version"}</h3><p>{order?.external_reference ?? shortHash(job.order_version_id)}{version ? ` · order v${version.version}` : ""} · circuit v{job.circuit_version}</p></div><StatusBadge value={job.status} /></div>
          <div className="proof-progress" aria-label={`Proof status ${job.status}`}>{lifecycle.map((stage, index) => <span className={currentStage >= 0 && index < currentStage ? "done" : currentStage === index ? "current" : ""} key={stage}><i />{stage}</span>)}</div>
          <div className="proof-job-meta"><div><span>Capacity state</span><strong className="mono">{opening ? shortHash(opening.chain_state_key) : "Factory-confidential"}</strong></div><div><span>Created</span><strong>{formatDate(job.created_at)}</strong></div><div><span>Started</span><strong>{formatDate(job.started_at)}</strong></div><div><span>Completed</span><strong>{formatDate(job.completed_at)}</strong></div></div>
          {exception ? <div className="proof-exception"><strong>{job.error_code || (job.status === "stale" ? "State became stale" : "Proof job failed")}</strong><span>{job.error_detail || "No canonical capacity transition was accepted for this job."}</span></div> : null}
          <a className="proof-evidence-link" href={`/app/proofs/${job.id}`}>Open proof evidence →</a>
        </article>;
      })}</div> : <div className="empty-state large"><strong>No proof jobs in this organization context</strong><span>{activeRole === "factory" ? "Queueing becomes available when this factory has both an authorized order version and an active private opening." : activeRole === "buyer" ? "Confirmed or in-flight feasibility proofs for this buyer's visible orders will appear here without exposing factory witness state." : "Switch to a buyer or factory organization to view proof operations."}</span></div>}
    </section>
  </div>;
}