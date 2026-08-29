import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const [ordersCount, credentialsCount, proofsCount, proposalsCount, recentOrders, recentEvents, chain] = await Promise.all([
    supabase.from("purchase_orders").select("id", { count: "exact", head: true }),
    supabase.from("credentials").select("id", { count: "exact", head: true }),
    supabase.from("proof_jobs").select("id", { count: "exact", head: true }),
    supabase.from("governance_proposal_read_model").select("chain_proposal_id", { count: "exact", head: true }),
    supabase.from("purchase_orders").select("id,external_reference,title,status,updated_at").order("updated_at", { ascending: false }).limit(5),
    supabase.from("chain_events").select("id,event_name,transaction_hash,block_number,observed_at").order("block_number", { ascending: false }).limit(5),
    getBlockchainStatus(),
  ]);
  const roles = [...viewer.roles].map(titleCase).join(" · ");

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">LIVE WORKSPACE</span><h1>Protocol operations</h1><p>Only data authorized by your consortium memberships is visible. Critical writes remain chain-gated.</p></div><div className={`chain-pill ${chain.online ? "online" : "offline"}`}><span />{chain.configured ? (chain.online ? `Chain online · block ${chain.blockNumber}` : "Chain unavailable") : "Chain RPC not configured"}</div></header>

      <section className="stat-grid">
        <article className="stat-card"><span>Visible orders</span><strong>{ordersCount.count ?? 0}</strong><small>Buyer/factory scoped</small></article>
        <article className="stat-card"><span>Credentials</span><strong>{credentialsCount.count ?? 0}</strong><small>Consortium metadata</small></article>
        <article className="stat-card"><span>Proof jobs</span><strong>{proofsCount.count ?? 0}</strong><small>Counterparty scoped</small></article>
        <article className="stat-card"><span>Governance</span><strong>{proposalsCount.count ?? 0}</strong><small>Indexed proposals</small></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-heading"><div><span className="kicker">RECENT WORK</span><h2>Orders</h2></div><Link href="/app/orders">View all</Link></div>
          {(recentOrders.data ?? []).length ? <div className="record-list">{(recentOrders.data ?? []).map((order) => <Link className="record-row" href={`/app/orders/${order.id}`} key={order.id}><div><strong>{order.title || order.external_reference}</strong><span>{order.external_reference} · updated {formatDate(order.updated_at)}</span></div><StatusBadge value={order.status} /></Link>)}</div> : <div className="empty-state"><strong>No visible orders yet</strong><span>Buyer operators can create private draft orders once counterparties are onboarded.</span></div>}
        </article>
        <article className="panel">
          <div className="panel-heading"><div><span className="kicker">CANONICAL MIRROR</span><h2>Chain events</h2></div><Link href="/app/chain">Inspect</Link></div>
          {(recentEvents.data ?? []).length ? <div className="record-list">{(recentEvents.data ?? []).map((event) => <div className="record-row" key={event.id}><div><strong>{titleCase(event.event_name)}</strong><span>Block {event.block_number} · {shortHash(event.transaction_hash)}</span></div></div>)}</div> : <div className="empty-state"><strong>No indexed events</strong><span>The indexer read model is empty. Direct chain validation remains required for critical writes.</span></div>}
        </article>
      </section>

      <section className="protocol-banner"><div><span className="kicker">YOUR ACCESS</span><h2>{roles || "Consortium member"}</h2></div><p>Application roles control workflow visibility. On-chain organization accounts control protocol signatures and canonical authorization.</p></section>
    </div>
  );
}
