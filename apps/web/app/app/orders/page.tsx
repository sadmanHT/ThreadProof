import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, formatQuantity } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const PIPELINE_STATES = ["prepared", "signed", "submitting", "submitted"];
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

export default async function OrdersPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const activeOrganizationId = active?.organization_id ?? EMPTY_UUID;
  const activeRole = active?.organization.role;
  const supabase = await createClient();

  const ordersBase = supabase.from("purchase_orders").select("*").order("updated_at", { ascending: false });
  const ordersQuery = activeRole === "buyer"
    ? ordersBase.eq("buyer_organization_id", activeOrganizationId)
    : activeRole === "factory"
      ? ordersBase.eq("factory_organization_id", activeOrganizationId)
      : ordersBase.eq("id", EMPTY_UUID);
  const authorizationBase = supabase.from("order_authorization_jobs").select("purchase_order_id,target_version,status,updated_at").in("status", PIPELINE_STATES).order("updated_at", { ascending: false });
  const cancellationBase = supabase.from("order_cancellation_jobs").select("purchase_order_id,expected_version,status,updated_at").in("status", [...PIPELINE_STATES, "confirmed"]).order("updated_at", { ascending: false });

  const [{ data: orders }, { data: organizations }, { data: authorizationJobs }, { data: cancellationJobs }] = await Promise.all([
    ordersQuery,
    supabase.from("organizations").select("id,display_name,role,status"),
    activeRole === "buyer" ? authorizationBase.eq("buyer_organization_id", activeOrganizationId) : authorizationBase.eq("buyer_organization_id", EMPTY_UUID),
    activeRole === "buyer" ? cancellationBase.eq("buyer_organization_id", activeOrganizationId) : cancellationBase.eq("buyer_organization_id", EMPTY_UUID),
  ]);
  const orderRows = orders ?? [];
  const orgMap = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
  const authorizationByOrder = new Map<string, NonNullable<typeof authorizationJobs>[number]>();
  for (const job of authorizationJobs ?? []) if (!authorizationByOrder.has(job.purchase_order_id)) authorizationByOrder.set(job.purchase_order_id, job);
  const cancellationByOrder = new Map<string, NonNullable<typeof cancellationJobs>[number]>();
  for (const job of cancellationJobs ?? []) if (!cancellationByOrder.has(job.purchase_order_id)) cancellationByOrder.set(job.purchase_order_id, job);
  const canCreate = !!active && active.organization.role === "buyer" && hasOperationalRole(active);
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  const draftCount = orderRows.filter((order) => order.current_version === 0).length;
  const anchoredCount = orderRows.filter((order) => order.current_version > 0 && order.status !== "cancelled").length;
  const inFlightCount = new Set([...(authorizationJobs ?? []).map((job) => job.purchase_order_id), ...(cancellationJobs ?? []).filter((job) => job.status !== "confirmed").map((job) => job.purchase_order_id)]).size;
  const cancelledCount = orderRows.filter((order) => order.status === "cancelled").length;

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">ORDER REGISTRY WORKFLOW</span><h1>Orders</h1><p>Private commercial coordination on one side; immutable buyer authorization on the other. This view is scoped to {active?.organization.display_name ?? "your active organization"} while RLS remains the underlying access boundary.</p></div>{canCreate ? <Link className="button primary" href="/app/orders/new">New draft order</Link> : null}</header>
      {message ? <div className="alert alert-success">{message}</div> : null}{error ? <div className="alert alert-error">{error}</div> : null}

      <section className="order-summary-grid" aria-label="Order workflow summary">
        <article className="order-summary-card"><span>Context orders</span><strong>{orderRows.length}</strong><small>{activeRole === "buyer" ? "buyer-owned portfolio" : activeRole === "factory" ? "factory-assigned portfolio" : "no operational order role"}</small></article>
        <article className="order-summary-card"><span>Draft only</span><strong>{draftCount}</strong><small>No canonical version yet</small></article>
        <article className="order-summary-card"><span>Anchored active</span><strong>{anchoredCount}</strong><small>Current OrderRegistry version</small></article>
        <article className="order-summary-card"><span>Buyer actions in flight</span><strong>{inFlightCount}</strong><small>{cancelledCount} cancelled historically</small></article>
      </section>

      <section className="panel table-panel">
        {orderRows.length ? <div className="data-table order-table"><div className="table-row table-head"><span>Order</span><span>Counterparties</span><span>Quantity</span><span>Canonical</span><span>Pipeline</span><span>Updated</span></div>{orderRows.map((order) => {
          const cancellation = cancellationByOrder.get(order.id);
          const authorization = authorizationByOrder.get(order.id);
          const pipeline = cancellation
            ? { label: cancellation.status === "confirmed" ? "Cancellation confirmed" : `Cancel v${cancellation.expected_version}`, status: cancellation.status }
            : authorization
              ? { label: `Version ${authorization.target_version}`, status: authorization.status }
              : null;
          return <Link href={`/app/orders/${order.id}`} className="table-row" key={order.id}><span><strong>{order.title || order.external_reference}</strong><small>{order.external_reference}</small></span><span><strong>{orgMap.get(order.buyer_organization_id)?.display_name ?? "Buyer"}</strong><small>→ {order.factory_organization_id ? orgMap.get(order.factory_organization_id)?.display_name ?? "Factory" : "Factory not set"}</small></span><span>{formatQuantity(order.quantity, order.unit)}</span><span><StatusBadge value={order.status} /></span><span>{pipeline ? <span className="pipeline-cell"><small>{pipeline.label}</small><StatusBadge value={pipeline.status} /></span> : <small className="muted">{activeRole === "buyer" ? "No buyer action in flight" : "Buyer pipeline hidden in factory context"}</small>}</span><span>{formatDate(order.updated_at)}</span></Link>;
        })}</div> : <div className="empty-state large"><strong>No orders in this organization context</strong><span>Switch organizations to view another membership. RLS still determines which buyer/factory relationships this account may read at all.</span>{canCreate ? <Link className="button secondary" href="/app/orders/new">Create first draft</Link> : null}</div>}
      </section>
      <p className="order-trust-note">Canonical status changes only from indexed OrderRegistry events. Active-organization scope is an application context boundary; it never replaces RLS, signatures or on-chain authority.</p>
    </div>
  );
}
