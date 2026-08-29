import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChainPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: events }, chain] = await Promise.all([
    supabase.from("chain_events").select("*").order("block_number", { ascending: false }).order("log_index", { ascending: false }).limit(100),
    getBlockchainStatus(),
  ]);
  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">BESU READ MODEL</span><h1>Chain activity</h1><p>This timeline is an indexed convenience view. Critical writes must validate directly against the consortium network.</p></div><div className={`chain-pill ${chain.online ? "online" : "offline"}`}><span />{chain.configured ? (chain.online ? `Chain ${chain.chainId} · block ${chain.blockNumber}` : "RPC unreachable") : "RPC not configured"}</div></header><section className="panel table-panel">{(events ?? []).length ? <div className="data-table chain-table"><div className="table-row table-head"><span>Block</span><span>Event</span><span>Transaction</span><span>Contract</span><span>Observed</span></div>{(events ?? []).map((event) => <div className="table-row" key={event.id}><span><strong>{event.block_number}</strong><small>log {event.log_index}</small></span><span>{titleCase(event.event_name)}</span><span className="mono">{shortHash(event.transaction_hash)}</span><span className="mono">{shortHash(event.contract_address)}</span><span>{formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</span></div>)}</div> : <div className="empty-state large"><strong>No blockchain events indexed</strong><span>Start the event indexer against the deployed Besu network to populate this read model.</span></div>}</section></div>;
}
