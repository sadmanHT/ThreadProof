import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash } from "@/lib/format";
import type { Json } from "@/lib/database.types";
import { StatusBadge } from "@/components/status-badge";
import { SubcontractAuthorizationForm } from "@/components/subcontract-authorization-form";

export const dynamic = "force-dynamic";

function field(data: Json, key: string) {
  if (!data || Array.isArray(data) || typeof data !== "object") return null;
  const value = data[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export default async function SubcontractsPage() {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const supabase = await createClient();
  const canAuthorize = !!active
    && active.organization.role === "factory"
    && active.organization.status === "active"
    && hasOperationalRole(active);

  const parentOrdersQuery = canAuthorize && active
    ? supabase
      .from("purchase_orders")
      .select("id,external_reference,title,chain_order_id,current_version,status,updated_at")
      .eq("factory_organization_id", active.organization_id)
      .gt("current_version", 0)
      .in("status", ["proposed", "feasible", "infeasible", "accepted"])
      .order("updated_at", { ascending: false })
    : Promise.resolve({ data: [], error: null });

  const [{ data: events }, { data: organizations }, { data: visibleOrders }, { data: jobs }, parentOrdersResult] = await Promise.all([
    supabase.from("chain_events").select("id,event_name,data,transaction_hash,block_number,observed_at").in("event_name", ["SubcontractAuthorized", "SubcontractPolicyRegistered"]).order("block_number", { ascending: false }).limit(100),
    supabase.from("organizations").select("id,display_name,chain_organization_id,status,role"),
    supabase.from("purchase_orders").select("id,chain_order_id,external_reference,title,status"),
    supabase.from("subcontract_authorization_jobs").select("*").order("created_at", { ascending: false }).limit(60),
    parentOrdersQuery,
  ]);
  const parentOrders = parentOrdersResult.data ?? [];
  const orgByChain = new Map((organizations ?? []).map((org) => [org.chain_organization_id.toLowerCase(), org]));
  const orgById = new Map((organizations ?? []).map((org) => [org.id, org]));
  const orderByChain = new Map((visibleOrders ?? []).map((order) => [order.chain_order_id.toLowerCase(), order]));
  const orderById = new Map((visibleOrders ?? []).map((order) => [order.id, order]));
  const authorizations = (events ?? []).filter((event) => event.event_name === "SubcontractAuthorized");
  const policies = (events ?? []).filter((event) => event.event_name === "SubcontractPolicyRegistered");

  return <div className="workspace-page">
    <header className="page-header">
      <div>
        <span className="kicker">CHAIN OF AUTHORIZATION</span>
        <h1>Subcontracts</h1>
        <p>Build and audit explicit parent-child production relationships without exposing private allocation quantities or unrelated commercial terms. Buyer consent stays in OrderRegistry; the parent factory signs the exact canonical subcontract tuple.</p>
      </div>
      <Link className="button secondary" href="/app/audit">Open audit trail</Link>
    </header>

    <section className="subcontract-principles">
      <article><span>Buyer consent</span><strong>Inherited from both current orders</strong><small>No second hidden buyer approval path</small></article>
      <article><span>Parent factory</span><strong>Signs exact EIP-712 tuple</strong><small>Nonce + sequence bound</small></article>
      <article><span>Credentials</span><strong>Revalidated by the governor</strong><small>Compliance + process scope</small></article>
      <article><span>Capacity</span><strong>Child allocation must be canonical</strong><small>Exact quantity remains undisclosed</small></article>
    </section>

    {canAuthorize ? <SubcontractAuthorizationForm parentOrders={parentOrders.map((order) => ({ id: order.id, reference: order.external_reference, title: order.title, chainOrderId: order.chain_order_id }))} /> : (
      <section className="panel trust-panel">
        <span className="kicker">SIGNING AUTHORITY</span>
        <h2>Parent-factory authorization only</h2>
        <p>Preparing a new subcontract requires an active factory context with operator, signer, or admin authority. Buyers and subcontractors can still audit relevant queued and canonical relationships below.</p>
      </section>
    )}

    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">OPERATIONAL PIPELINE</span><h2>Subcontract authorization jobs</h2></div><span className="panel-count">{(jobs ?? []).length}</span></div>
      {(jobs ?? []).length ? <div className="record-list">{(jobs ?? []).map((job) => {
        const parent = orderById.get(job.parent_order_id);
        const child = orderById.get(job.child_order_id);
        const parentFactory = orgById.get(job.parent_factory_organization_id);
        const subcontractor = orgById.get(job.subcontractor_organization_id);
        return <div className="record-row" key={job.id}>
          <div>
            <strong>{parent?.external_reference ?? shortHash(job.parent_chain_order_id)} → {child?.external_reference ?? shortHash(job.child_chain_order_id)}</strong>
            <span>{parentFactory?.display_name ?? "Parent factory"} → {subcontractor?.display_name ?? "Subcontractor"} · sequence {job.sequence} · deadline {formatDate(job.deadline, { dateStyle: "medium", timeStyle: "short" })}{job.error_detail ? ` · ${job.error_detail}` : ""}</span>
          </div>
          <div className="record-meta">
            <StatusBadge value={job.status} />
            {job.chain_tx_hash ? <Link className="mono" href={`/app/chain/transactions/${job.chain_tx_hash}`}>{shortHash(job.chain_tx_hash)}</Link> : <span className="mono">nonce {job.nonce}</span>}
          </div>
        </div>;
      })}</div> : <div className="empty-state"><strong>No subcontract signing jobs yet</strong><span>Prepared, signed, relayed, stale and failed attempts appear here for relevant parent factories, subcontractors and buyers. The queue itself never grants production authority.</span></div>}
    </section>

    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">CANONICAL RELATIONSHIPS</span><h2>Authorized production paths</h2></div><span className="panel-count">{authorizations.length}</span></div>
      {authorizations.length ? <div className="subcontract-list">{authorizations.map((event) => {
        const parentId = field(event.data, "parentOrderId");
        const childId = field(event.data, "childOrderId");
        const parentFactoryId = field(event.data, "parentFactoryOrganizationId");
        const subcontractorId = field(event.data, "subcontractorOrganizationId");
        const parentFactory = parentFactoryId ? orgByChain.get(parentFactoryId.toLowerCase()) : undefined;
        const subcontractor = subcontractorId ? orgByChain.get(subcontractorId.toLowerCase()) : undefined;
        const parentOrder = parentId ? orderByChain.get(parentId.toLowerCase()) : undefined;
        const childOrder = childId ? orderByChain.get(childId.toLowerCase()) : undefined;
        const depth = field(event.data, "depth");
        return <article className="subcontract-record" key={event.id}>
          <div className="subcontract-path">
            <div><span className="path-node primary">P</span><strong>{parentFactory?.display_name ?? "Parent factory"}</strong><small>{parentOrder ? parentOrder.external_reference : parentId ? shortHash(parentId) : "Parent order"}</small></div>
            <i>→</i>
            <div><span className="path-node child">S</span><strong>{subcontractor?.display_name ?? "Subcontractor"}</strong><small>{childOrder ? childOrder.external_reference : childId ? shortHash(childId) : "Child order"}</small></div>
          </div>
          <div className="subcontract-record-meta">
            <span className="privacy-chip consortium">Canonical authorization</span>
            <dl><div><dt>Depth</dt><dd>{depth ?? "—"}</dd></div><div><dt>Block</dt><dd>#{Number(event.block_number).toLocaleString()}</dd></div><div><dt>Transaction</dt><dd><Link className="mono" href={`/app/chain/transactions/${event.transaction_hash}`}>{shortHash(event.transaction_hash)}</Link></dd></div><div><dt>Observed</dt><dd>{formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl>
          </div>
        </article>;
      })}</div> : <div className="empty-state large"><strong>No subcontract authorizations indexed</strong><span>When SubcontractGovernor finalizes an authorization, its parent-child path will appear here. An absence of events is not permission to subcontract outside the protocol.</span></div>}
    </section>

    <section className="panel">
      <div className="panel-heading"><div><span className="kicker">POLICY PROVENANCE</span><h2>Registered subcontract policies</h2></div><span className="panel-count">{policies.length}</span></div>
      {policies.length ? <div className="record-list">{policies.map((event) => <div className="record-row" key={event.id}>
        <div><strong>Policy {shortHash(field(event.data, "policyHash") ?? "")}</strong><span>Maximum depth {field(event.data, "maxDepth") ?? "—"} · block {Number(event.block_number).toLocaleString()}</span></div>
        <Link className="mono" href={`/app/chain/transactions/${event.transaction_hash}`}>{shortHash(event.transaction_hash)}</Link>
      </div>)}</div> : <div className="empty-state"><strong>No subcontract policy events indexed</strong><span>Charter-governed policy registration will appear here once observed by the indexer.</span></div>}
    </section>
    <p className="footnote">The operational queue is non-canonical and rebuildable. Only SubcontractGovernor determines whether a parent-child production relationship exists and remains active.</p>
  </div>;
}
