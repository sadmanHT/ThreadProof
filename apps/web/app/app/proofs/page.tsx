import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { queueProofAction } from "@/app/app/actions";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ProofsPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: jobs }, { data: versions }, { data: orders }, { data: openings }] = await Promise.all([
    supabase.from("proof_jobs").select("id,factory_organization_id,order_version_id,capacity_opening_id,status,circuit_version,error_code,error_detail,started_at,completed_at,created_at").order("created_at", { ascending: false }),
    supabase.from("order_versions").select("id,purchase_order_id,version,order_commitment,created_at").order("created_at", { ascending: false }),
    supabase.from("purchase_orders").select("id,external_reference,title,factory_organization_id,status,current_version"),
    supabase.from("private_capacity_openings").select("id,factory_organization_id,period_id,process_id,status,circuit_version,chain_state_key").eq("status", "active"),
  ]);
  const versionMap = new Map((versions ?? []).map((version) => [version.id, version]));
  const orderMap = new Map((orders ?? []).map((order) => [order.id, order]));
  const openingMap = new Map((openings ?? []).map((opening) => [opening.id, opening]));
  const canQueue = viewer.roles.has("factory") && (versions ?? []).length > 0 && (openings ?? []).length > 0;
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;

  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">PROOF-OF-FEASIBLE-CAPACITY</span><h1>Proof jobs</h1><p>The application may queue proof work. Only a valid proof accepted against the current CapacityVault state can advance canonical capacity.</p></div></header>{message ? <div className="alert alert-success">{message}</div> : null}{error ? <div className="alert alert-error">{error}</div> : null}{canQueue ? <section className="panel form-panel"><div className="panel-heading"><div><span className="kicker">FACTORY ACTION</span><h2>Queue feasibility proof</h2></div></div><form className="inline-form proof-queue" action={queueProofAction}><label>Authorized order version<select name="orderVersionId" required defaultValue=""><option value="" disabled>Select version</option>{(versions ?? []).map((version) => { const order = orderMap.get(version.purchase_order_id); return order ? <option key={version.id} value={version.id}>{order.external_reference} · v{version.version} · {shortHash(version.order_commitment)}</option> : null; })}</select></label><label>Active capacity state<select name="capacityOpeningId" required defaultValue=""><option value="" disabled>Select state</option>{(openings ?? []).map((opening) => <option key={opening.id} value={opening.id}>{opening.period_id} · {opening.process_id} · circuit v{opening.circuit_version}</option>)}</select></label><button className="button primary">Queue proof</button></form><p className="form-help">The RPC rejects factory mismatches and inactive states. Proof generation, verification and chain submission are worker/service operations.</p></section> : null}<section className="panel table-panel">{(jobs ?? []).length ? <div className="data-table proof-table"><div className="table-row table-head"><span>Order</span><span>Capacity context</span><span>Circuit</span><span>Status</span><span>Created</span></div>{(jobs ?? []).map((job) => { const version = versionMap.get(job.order_version_id); const order = version ? orderMap.get(version.purchase_order_id) : null; const opening = openingMap.get(job.capacity_opening_id); return <div className="table-row" key={job.id}><span><strong>{order?.title || order?.external_reference || "Order version"}</strong><small>{version ? `v${version.version}` : shortHash(job.order_version_id)}</small></span><span>{opening ? `${opening.period_id} · ${opening.process_id}` : shortHash(job.capacity_opening_id)}</span><span>v{job.circuit_version}</span><span><StatusBadge value={job.status} />{job.error_code ? <small>{job.error_code}</small> : null}</span><span>{formatDate(job.created_at)}</span></div>; })}</div> : <div className="empty-state large"><strong>No proof jobs yet</strong><span>Factories can queue a proof only when an indexed signed order version and a private active capacity opening are both available.</span></div>}</section></div>;
}
