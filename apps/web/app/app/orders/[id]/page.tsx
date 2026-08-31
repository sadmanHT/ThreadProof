import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, formatQuantity, shortHash } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { OrderAuthorizationForm } from "@/components/order-authorization-form";
import { OrderCancellationForm } from "@/components/order-cancellation-form";
import { deleteOrderAction, updateOrderAction } from "@/app/app/actions";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const ACTIVE_JOB_STATES = new Set(["prepared", "signed", "submitting", "submitted"]);

export default async function OrderDetailPage({ params, searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const { id } = await params;
  const supabase = await createClient();
  const { data: order } = await supabase.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (!order) notFound();

  const [{ data: versions }, { data: orgs }, { data: authorizationJobs }, { data: cancellationJobs }] = await Promise.all([
    supabase.from("order_versions").select("id,version,previous_version_hash,version_hash,order_commitment,workload_commitment,policy_hash,production_period_start,production_period_end,buyer_signature,chain_tx_hash,chain_block_number,created_at").eq("purchase_order_id", id).order("version", { ascending: false }),
    supabase.from("organizations").select("id,display_name,role,chain_organization_id,status").in("id", [order.buyer_organization_id, ...(order.factory_organization_id ? [order.factory_organization_id] : [])]),
    supabase.from("order_authorization_jobs").select("id,target_version,status,deadline,chain_tx_hash,error_code,error_detail,created_at").eq("purchase_order_id", id).order("created_at", { ascending: false }).limit(12),
    supabase.from("order_cancellation_jobs").select("id,expected_version,status,deadline,chain_tx_hash,chain_block_number,error_code,error_detail,created_at").eq("purchase_order_id", id).order("created_at", { ascending: false }).limit(12),
  ]);
  const orgMap = new Map((orgs ?? []).map((org) => [org.id, org]));
  const buyerMembership = viewer.memberships.find((membership) => membership.organization_id === order.buyer_organization_id);
  const canOperate = !!buyerMembership && hasOperationalRole(buyerMembership);
  const activeAuthorization = (authorizationJobs ?? []).find((job) => ACTIVE_JOB_STATES.has(job.status));
  const activeCancellation = (cancellationJobs ?? []).find((job) => ACTIVE_JOB_STATES.has(job.status));
  const canEditDraft = order.status === "draft" && canOperate;
  const canAuthorize = canOperate && !activeCancellation && !!order.factory_organization_id && ["draft", "proposed", "feasible", "infeasible"].includes(order.status);
  const canCancel = canOperate && !activeAuthorization && !activeCancellation && order.current_version > 0 && ["proposed", "feasible", "infeasible", "accepted"].includes(order.status);
  const paramsQuery = await searchParams;
  const message = typeof paramsQuery.message === "string" ? paramsQuery.message : null;
  const error = typeof paramsQuery.error === "string" ? paramsQuery.error : null;

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">ORDER · {order.external_reference}</span><h1>{order.title || order.external_reference}</h1><p>{orgMap.get(order.buyer_organization_id)?.display_name ?? "Buyer"} → {order.factory_organization_id ? orgMap.get(order.factory_organization_id)?.display_name ?? "Factory" : "Factory not set"}</p></div><StatusBadge value={order.status} /></header>
      {message ? <div className="alert alert-success">{message}</div> : null}{error ? <div className="alert alert-error">{error}</div> : null}
      {activeCancellation ? <div className="alert alert-warning">Cancellation for anchored version {activeCancellation.expected_version} is {activeCancellation.status}. This order remains canonically active until OrderCancelled is indexed.</div> : null}

      <section className="detail-grid">
        <article className="panel"><div className="panel-heading"><div><span className="kicker">COMMERCIAL METADATA</span><h2>Private order summary</h2></div></div><dl className="definition-grid"><div><dt>Quantity</dt><dd>{formatQuantity(order.quantity, order.unit)}</dd></div><div><dt>Category</dt><dd>{order.product_category || "—"}</dd></div><div><dt>Requested delivery</dt><dd>{formatDate(order.requested_delivery_date)}</dd></div><div><dt>Created</dt><dd>{formatDate(order.created_at)}</dd></div></dl></article>
        <article className="panel trust-panel"><span className="kicker">CANONICAL AUTHORIZATION</span><h2>{order.current_version > 0 ? `Version ${order.current_version} anchored` : "Not yet anchored"}</h2><p>{order.status === "cancelled" ? "OrderRegistry emitted OrderCancelled. Old version history remains immutable, but the current order can no longer authorize capacity spending or subcontracting." : order.current_version > 0 ? "The application mirrors the current OrderRegistry authorization. A capacity proof must bind to this exact current commitment." : "This row is an application draft only. It cannot authorize production or consume certified capacity until a buyer-signed OrderRegistry event is indexed."}</p><dl className="definition-grid"><div><dt>Chain order ID</dt><dd className="mono">{shortHash(order.chain_order_id)}</dd></div><div><dt>Order commitment</dt><dd className="mono">{shortHash(order.current_order_commitment)}</dd></div><div><dt>Policy hash</dt><dd className="mono">{shortHash(order.current_policy_hash)}</dd></div></dl></article>
      </section>

      {canEditDraft ? <section className="panel form-panel"><div className="panel-heading"><div><span className="kicker">BUYER DRAFT</span><h2>Edit operational details</h2></div></div><form className="stack-form" action={updateOrderAction}><input type="hidden" name="orderId" value={order.id} /><div className="field-grid two"><label>External reference<input name="externalReference" required defaultValue={order.external_reference} /></label><label>Title<input name="title" required defaultValue={order.title ?? ""} /></label></div><div className="field-grid three"><label>Product category<input name="productCategory" defaultValue={order.product_category ?? ""} /></label><label>Quantity<input name="quantity" type="number" min="0.001" step="0.001" required defaultValue={order.quantity ?? undefined} /></label><label>Unit<input name="unit" required defaultValue={order.unit ?? "pieces"} /></label></div><label>Requested delivery<input name="requestedDeliveryDate" type="date" defaultValue={order.requested_delivery_date ?? ""} /></label><div className="form-actions"><button className="button secondary">Save draft</button></div></form><form action={deleteOrderAction} className="danger-zone"><input type="hidden" name="orderId" value={order.id} /><div><strong>Discard draft</strong><span>Only version-zero drafts can be deleted.</span></div><button className="button danger">Delete draft</button></form></section> : null}

      {canAuthorize ? <OrderAuthorizationForm orderId={order.id} nextVersion={order.current_version + 1} /> : null}
      {canCancel ? <OrderCancellationForm orderId={order.id} currentVersion={order.current_version} /> : null}

      <section className="panel"><div className="panel-heading"><div><span className="kicker">SIGNATURE PIPELINE</span><h2>Buyer authorization jobs</h2></div></div>{(authorizationJobs ?? []).length ? <div className="record-list">{(authorizationJobs ?? []).map((job) => <div className="record-row" key={job.id}><div><strong>Version {job.target_version}</strong><span>{formatDate(job.created_at)} · deadline {formatDate(job.deadline)}{job.error_detail ? ` · ${job.error_detail}` : ""}</span></div><div className="record-meta"><StatusBadge value={job.status} />{job.chain_tx_hash ? <span className="mono">{shortHash(job.chain_tx_hash)}</span> : null}</div></div>)}</div> : <div className="empty-state"><strong>No authorization jobs yet</strong><span>Preparing a version creates an encrypted commitment package; only a valid buyer wallet signature can move it into the relayer queue.</span></div>}</section>

      {(order.current_version > 0 || (cancellationJobs ?? []).length > 0) ? <section className="panel"><div className="panel-heading"><div><span className="kicker">CANCELLATION PIPELINE</span><h2>Buyer cancellation jobs</h2></div></div>{(cancellationJobs ?? []).length ? <div className="record-list">{(cancellationJobs ?? []).map((job) => <div className="record-row" key={job.id}><div><strong>Cancel version {job.expected_version}</strong><span>{formatDate(job.created_at)} · deadline {formatDate(job.deadline)}{job.chain_block_number ? ` · block ${job.chain_block_number}` : ""}{job.error_detail ? ` · ${job.error_detail}` : ""}</span></div><div className="record-meta"><StatusBadge value={job.status} />{job.chain_tx_hash ? <span className="mono">{shortHash(job.chain_tx_hash)}</span> : null}</div></div>)}</div> : <div className="empty-state"><strong>No cancellation jobs</strong><span>A cancellation appears here only after a buyer operator prepares the canonical version- and nonce-bound EIP-712 request.</span></div>}</section> : null}

      <section className="panel"><div className="panel-heading"><div><span className="kicker">IMMUTABLE HISTORY</span><h2>OrderRegistry versions</h2></div></div>{(versions ?? []).length ? <div className="record-list">{(versions ?? []).map((version) => <div className="record-row" key={version.id}><div><strong>Version {version.version}</strong><span>{formatDate(version.created_at)} · commitment <span className="mono">{shortHash(version.order_commitment)}</span>{version.chain_block_number ? ` · block ${version.chain_block_number}` : ""}</span></div><div className="record-meta"><span className="mono">{shortHash(version.version_hash)}</span><span className="mono">{shortHash(version.policy_hash)}</span></div></div>)}</div> : <div className="empty-state"><strong>No signed versions indexed yet</strong><span>OrderRegistry events populate this history only after a valid buyer authorization has been relayed and observed on Besu.</span></div>}</section>
    </div>
  );
}
