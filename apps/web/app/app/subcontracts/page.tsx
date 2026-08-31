import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash } from "@/lib/format";
import type { Json } from "@/lib/database.types";

export const dynamic = "force-dynamic";

function field(data: Json, key: string) {
  if (!data || Array.isArray(data) || typeof data !== "object") return null;
  const value = data[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export default async function SubcontractsPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: events }, { data: organizations }, { data: orders }] = await Promise.all([
    supabase.from("chain_events").select("id,event_name,data,transaction_hash,block_number,observed_at").in("event_name", ["SubcontractAuthorized", "SubcontractPolicyRegistered"]).order("block_number", { ascending: false }).limit(100),
    supabase.from("organizations").select("id,display_name,chain_organization_id,status,role"),
    supabase.from("purchase_orders").select("id,chain_order_id,external_reference,title,status"),
  ]);
  const orgByChain = new Map((organizations ?? []).map((org) => [org.chain_organization_id.toLowerCase(), org]));
  const orderByChain = new Map((orders ?? []).map((order) => [order.chain_order_id.toLowerCase(), order]));
  const authorizations = (events ?? []).filter((event) => event.event_name === "SubcontractAuthorized");
  const policies = (events ?? []).filter((event) => event.event_name === "SubcontractPolicyRegistered");

  return <div className="workspace-page">
    <header className="page-header"><div><span className="kicker">CHAIN OF AUTHORIZATION</span><h1>Subcontracts</h1><p>Authorized subcontracting is an explicit parent-child production relationship. This screen reconstructs canonical SubcontractGovernor events without exposing private allocation quantities or unrelated commercial terms.</p></div><Link className="button secondary" href="/app/audit">Open audit trail</Link></header>
    <section className="subcontract-principles"><article><span>Parent order</span><strong>Must be current and active</strong><small>Buyer-authorized OrderRegistry state</small></article><article><span>Factory path</span><strong>Must remain within policy depth</strong><small>No disconnected production node</small></article><article><span>Credentials</span><strong>Checked when authorization occurs</strong><small>Compliance + process scope</small></article><article><span>Capacity</span><strong>Child allocation must already be valid</strong><small>Private quantity remains undisclosed</small></article></section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">CANONICAL RELATIONSHIPS</span><h2>Authorized production paths</h2></div><span className="panel-count">{authorizations.length}</span></div>{authorizations.length ? <div className="subcontract-list">{authorizations.map((event) => {
      const parentId = field(event.data, "parentOrderId");
      const childId = field(event.data, "childOrderId");
      const parentFactoryId = field(event.data, "parentFactoryOrganizationId");
      const subcontractorId = field(event.data, "subcontractorOrganizationId");
      const parentFactory = parentFactoryId ? orgByChain.get(parentFactoryId.toLowerCase()) : undefined;
      const subcontractor = subcontractorId ? orgByChain.get(subcontractorId.toLowerCase()) : undefined;
      const parentOrder = parentId ? orderByChain.get(parentId.toLowerCase()) : undefined;
      const childOrder = childId ? orderByChain.get(childId.toLowerCase()) : undefined;
      const depth = field(event.data, "depth");
      return <article className="subcontract-record" key={event.id}><div className="subcontract-path"><div><span className="path-node primary">P</span><strong>{parentFactory?.display_name ?? "Parent factory"}</strong><small>{parentOrder ? parentOrder.external_reference : parentId ? shortHash(parentId) : "Parent order"}</small></div><i>→</i><div><span className="path-node child">S</span><strong>{subcontractor?.display_name ?? "Subcontractor"}</strong><small>{childOrder ? childOrder.external_reference : childId ? shortHash(childId) : "Child order"}</small></div></div><div className="subcontract-record-meta"><span className="privacy-chip consortium">Canonical authorization</span><dl><div><dt>Depth</dt><dd>{depth ?? "—"}</dd></div><div><dt>Block</dt><dd>#{Number(event.block_number).toLocaleString()}</dd></div><div><dt>Transaction</dt><dd className="mono">{shortHash(event.transaction_hash)}</dd></div><div><dt>Observed</dt><dd>{formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div></dl></div></article>;
    })}</div> : <div className="empty-state large"><strong>No subcontract authorizations indexed</strong><span>When SubcontractGovernor finalizes an authorization, its parent-child path will appear here. An absence of events is not permission to subcontract outside the protocol.</span></div>}</section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">POLICY PROVENANCE</span><h2>Registered subcontract policies</h2></div><span className="panel-count">{policies.length}</span></div>{policies.length ? <div className="record-list">{policies.map((event) => <div className="record-row" key={event.id}><div><strong>Policy {shortHash(field(event.data, "policyHash") ?? "")}</strong><span>Maximum depth {field(event.data, "maxDepth") ?? "—"} · block {Number(event.block_number).toLocaleString()}</span></div><span className="mono">{shortHash(event.transaction_hash)}</span></div>)}</div> : <div className="empty-state"><strong>No subcontract policy events indexed</strong><span>Charter-governed policy registration will appear here once observed by the indexer.</span></div>}</section>
    <p className="footnote">This page intentionally does not show private subcontract allocation quantities. It exposes only the canonical authorization graph and protocol references available in SubcontractGovernor events.</p>
  </div>;
}
