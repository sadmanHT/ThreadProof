import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getTransactionProvenance } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ hash: string }> };

function provenanceBadge(status: string, canonical: boolean | null) {
  if (status === "success" && canonical === true) return "success";
  if (status === "pending") return "warning";
  return "danger";
}

function statusLabel(status: string, canonical: boolean | null) {
  if (status === "success" && canonical === true) return "Confirmed · canonical";
  if (status === "success") return "Confirmed · block mismatch";
  if (status === "reverted") return "Reverted";
  if (status === "pending") return "Pending";
  if (status === "not_found") return "Not found";
  return "Unavailable";
}

export default async function ChainTransactionPage({ params }: Props) {
  await requireConsortiumViewer();
  const { hash } = await params;
  const supabase = await createClient();

  const [provenance, eventResult] = await Promise.all([
    getTransactionProvenance(hash),
    supabase
      .from("chain_events")
      .select("block_number,block_hash,log_index,event_name,contract_address,observed_at")
      .eq("transaction_hash", hash)
      .order("log_index", { ascending: true }),
  ]);
  const events = eventResult.data ?? [];

  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <span className="kicker">CANONICAL TRANSACTION VERIFICATION</span>
          <h1>Transaction provenance</h1>
          <p className="mono" title={hash}>{hash}</p>
        </div>
        <Link className="button secondary small" href="/app/chain">Back to chain</Link>
      </header>

      {provenance.error && (
        <p className={`alert ${provenance.canonical === false || provenance.status === "reverted" ? "alert-error" : "alert-error"}`}>
          {provenance.error}
        </p>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">LIVE CONSORTIUM RPC</span>
            <h2>Receipt and canonical block binding</h2>
          </div>
          <span className={`badge ${provenanceBadge(provenance.status, provenance.canonical)}`}>
            {statusLabel(provenance.status, provenance.canonical)}
          </span>
        </div>

        <div className="chain-provenance-grid">
          <div className="chain-provenance-card">
            <span>Chain / confirmations</span>
            <strong>{provenance.chainId === null ? "Unavailable" : `Chain ${provenance.chainId}`}</strong>
            <code className="mono">{provenance.confirmations === null ? "confirmations unavailable" : `${provenance.confirmations} confirmation${provenance.confirmations === "1" ? "" : "s"}`}</code>
          </div>
          <div className="chain-provenance-card">
            <span>Receipt block</span>
            <strong>{provenance.blockNumber === null ? "Not mined" : `#${provenance.blockNumber}`}</strong>
            <code className="mono" title={provenance.blockHash ?? undefined}>{provenance.blockHash ? shortHash(provenance.blockHash) : "No receipt block hash"}</code>
          </div>
          <div className="chain-provenance-card">
            <span>Canonical hash check</span>
            <strong className="chain-status-line">
              <i className={`chain-status-dot ${provenance.canonical === true ? "good" : provenance.canonical === false ? "bad" : "warn"}`} />
              {provenance.canonical === true ? "Block hash matches" : provenance.canonical === false ? "Block hash mismatch" : "Not applicable"}
            </strong>
            <code className="mono" title={provenance.canonicalBlockHash ?? undefined}>{provenance.canonicalBlockHash ? shortHash(provenance.canonicalBlockHash) : "Canonical hash unavailable"}</code>
          </div>
          <div className="chain-provenance-card">
            <span>Execution</span>
            <strong>{provenance.status === "success" ? "Succeeded" : provenance.status === "reverted" ? "Reverted" : titleCase(provenance.status)}</strong>
            <code className="mono">{provenance.gasUsed ? `${provenance.gasUsed} gas used` : "Gas unavailable"}</code>
          </div>
          <div className="chain-provenance-card">
            <span>From</span>
            <code className="mono" title={provenance.from ?? undefined}>{provenance.from ?? "Unavailable"}</code>
          </div>
          <div className="chain-provenance-card">
            <span>To / created contract</span>
            <code className="mono" title={provenance.to ?? provenance.contractAddress ?? undefined}>{provenance.to ?? provenance.contractAddress ?? "Unavailable"}</code>
          </div>
        </div>
      </section>

      <div className="chain-trust-note">
        Receipt status, confirmations, and the block-hash comparison above are read directly from the configured consortium RPC.
        The event records below are a rebuildable Postgres projection and are shown only to explain what the indexed protocol
        worker observed for this transaction.
      </div>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">REBUILDABLE EVENT PROJECTION</span>
            <h2>Indexed protocol events</h2>
          </div>
          <span className="badge neutral">{events.length} event{events.length === 1 ? "" : "s"}</span>
        </div>
        {events.length ? (
          <div className="data-table chain-table">
            <div className="table-row table-head">
              <span>Block</span>
              <span>Event</span>
              <span>Contract</span>
              <span>Log</span>
              <span>Observed</span>
            </div>
            {events.map((event) => (
              <div className="table-row" key={`${event.block_number}:${event.log_index}:${event.contract_address}`}>
                <span>
                  <strong>{event.block_number}</strong>
                  <small className="mono" title={event.block_hash}>{shortHash(event.block_hash)}</small>
                </span>
                <span>{titleCase(event.event_name)}</span>
                <span className="mono" title={event.contract_address}>{shortHash(event.contract_address)}</span>
                <span>{event.log_index}</span>
                <span>{formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state large">
            <strong>No protocol event projection for this transaction</strong>
            <span>A successful receipt can still exist without a ThreadProof protocol event. Verify the live receipt above first.</span>
          </div>
        )}
      </section>
    </div>
  );
}
