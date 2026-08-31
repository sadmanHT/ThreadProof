import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { AuditEventExplorer } from "@/components/audit-event-explorer";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: events }, chain] = await Promise.all([
    supabase.from("chain_events").select("id,block_number,transaction_hash,contract_address,event_name,log_index,observed_at,indexed_values,data").order("block_number", { ascending: false }).order("log_index", { ascending: false }).limit(300),
    getBlockchainStatus(),
  ]);
  const rows = (events ?? []).map((event) => ({
    id: Number(event.id),
    blockNumber: Number(event.block_number),
    transactionHash: event.transaction_hash,
    contractAddress: event.contract_address,
    eventName: event.event_name,
    logIndex: event.log_index,
    observedAt: event.observed_at,
    indexedValues: event.indexed_values,
    data: event.data,
  }));
  const distinctContracts = new Set(rows.map((event) => event.contractAddress.toLowerCase())).size;
  const latestBlock = rows[0]?.blockNumber ?? chain.blockNumber ?? 0;

  return <div className="workspace-page">
    <header className="page-header"><div><span className="kicker">CANONICAL AUDIT TRAIL</span><h1>Protocol events</h1><p>Inspect the consortium's attributable event history without turning the application database into an authority source. Technical parameters stay available through progressive disclosure.</p></div><div className={`chain-pill ${chain.online ? "online" : "offline"}`}><span />{chain.configured ? (chain.online ? `Network online · block ${chain.blockNumber}` : "Network unavailable") : "RPC not configured"}</div></header>
    <section className="audit-stats"><article><span>Indexed events</span><strong>{rows.length.toLocaleString()}</strong><small>latest view</small></article><article><span>Latest indexed block</span><strong>{latestBlock ? `#${latestBlock.toLocaleString()}` : "—"}</strong><small>canonical mirror</small></article><article><span>Contracts represented</span><strong>{distinctContracts}</strong><small>in this window</small></article></section>
    <div className="protocol-banner audit-banner"><div><span className="kicker">READ MODEL</span><h2>Filter for meaning. Expand for cryptography.</h2></div><p>Normal operators see human-readable event names first. Hashes, decoded parameters and contract addresses remain one interaction away for technical review.</p></div>
    <AuditEventExplorer events={rows} />
  </div>;
}
