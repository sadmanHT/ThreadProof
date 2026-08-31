import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, formatQuantity } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const PIPELINE_STATES = ["prepared", "signed", "submitting", "submitted"];

export default async function OrdersPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: orders }, { data: organizations }, { data: authorizationJobs }, { data: cancellationJobs }] = await Promise.all([
    supabase.from("purchase_orders").select("*").order("updated_at", { ascending: false }),
    supabase.from("organizations").select("id,display_name,role,status"),
    supabase.from("order_authorization_jobs").select("purchase_order_id,target_version,status,updated_at").in("status", PIPELINE_STATES).order("updated_at", { ascending: false }),
    supabase.from("order_cancellation_jobs").select("purchase_order_id,expected_version,status,updated_at").in("status", [...PIPELINE_STATES, "confirmed"]).order("updated_at", { ascending: false }),
  ]);
  const orgMap = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
  const authorizationByOrder = new Map<string, NonNullable<typeof authorizationJobs>[number]>();
  for (const job of authorizationJobs ?? []) if (!authorizationByOrder.has(job.purchase_order_id)) authorizationByOrder.set(job.purchase_order_id, job);
  const cancellationByOrder = new Map<string, NonNullable<typeof cancellationJobs>[number]>();
  for (const job of cancellationJobs ?? []) if (!cancellationByOrder.has(job.purchase_order_id)) cancellationByOrder.set(job.purchase_order_id, job);
  const canCreate = viewer.memberships.some((membership) => membership.organization.role === "buyer" && hasOperationalRole(membership));
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">ORDER REGISTRY WORKFLOW</span><h1>Orders</h1><p>Commercial draft metadata stays private to counterparties. Buyer signatures and immutable order commitments become canonical on-chain.</p></div>{canCreate ? <Link className="button primary" href="/app/orders/new">New draft order</Link> : null}</header>
      {message ? <div className="alert alert-success">{message}</div> : null}{error ? <div className="alert alert-error">{error}</div> : null}
      <section className="panel table-panel">
        {(orders ?? []).length ? <div className="data-table order-table"><div className="table-row table-head"><span>Order</span><span>Counterparties</span><span>Quantity</span><span>Canonical</span><span>Pipeline</span><span>Updated</span></div>{(orders ?? []).map((order) => {
          const cancellation = cancellationByOrder.get(order.id);
          const authorization = authorizationByOrder.get(order.id);
          const pipeline = cancellation
            ? { label: cancellation.status === "confirmed" ? "Cancellation confirmed" : `Cancel v${cancellation.expected_version}`, status: cancellation.status }
            : authorization
              ? { label: `Version ${authorization.target_version}`, status: authorization.status }
              : null;
          return <Link href={`/app/orders/${order.id}`} className="table-row" key={order.id}><span><strong>{order.title || order.external_reference}</strong><small>{order.external_reference}</small></span><span><strong>{orgMap.get(order.buyer_organization_id)?.display_name ?? "Buyer"}</strong><small>→ {order.factory_organization_id ? orgMap.get(order.factory_organization_id)?.display_name ?? "Factory" : "Factory not set"}</small></span><span>{formatQuantity(order.quantity, order.unit)}</span><span><StatusBadge value={order.status} /></span><span>{pipeline ? <span className="pipeline-cell"><small>{pipeline.label}</small><StatusBadge value={pipeline.status} /></span> : <small className="muted">Idle</small>}</span><span>{formatDate(order.updated_at)}</span></Link>;
        })}</div> : <div className="empty-state large"><strong>No orders are visible to this account</strong><span>RLS exposes orders only to the buyer and primary factory organizations.</span>{canCreate ? <Link className="button secondary" href="/app/orders/new">Create first draft</Link> : null}</div>}
      </section>
      <p className="footnote">The canonical column changes only from indexed OrderRegistry events. Pipeline status shows off-chain staging and relayer progress and never grants order authority.</p>
    </div>
  );
}
