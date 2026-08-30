import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChainPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: events }, { data: verifierProvenance }, chain] = await Promise.all([
    supabase
      .from("chain_events")
      .select("*")
      .order("block_number", { ascending: false })
      .order("log_index", { ascending: false })
      .limit(100),
    supabase
      .from("verifier_provenance_read_model")
      .select("*")
      .order("circuit_version", { ascending: false }),
    getBlockchainStatus(),
  ]);

  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <span className="kicker">BESU READ MODEL</span>
          <h1>Chain activity</h1>
          <p>
            This timeline and verifier inventory are indexed convenience views. Critical writes and proof acceptance
            must validate directly against the consortium network.
          </p>
        </div>
        <div className={`chain-pill ${chain.online ? "online" : "offline"}`}>
          <span />
          {chain.configured
            ? chain.online
              ? `Chain ${chain.chainId} · block ${chain.blockNumber}`
              : "RPC unreachable"
            : "RPC not configured"}
        </div>
      </header>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">ZK VERIFIER PROVENANCE</span>
            <h2>Immutable circuit-version bindings</h2>
          </div>
        </div>
        {(verifierProvenance ?? []).length ? (
          <div className="data-table chain-table">
            <div className="table-row table-head">
              <span>Version</span>
              <span>Verifier</span>
              <span>Circuit / VK</span>
              <span>Runtime code</span>
              <span>Registration</span>
            </div>
            {(verifierProvenance ?? []).map((entry) => (
              <div className="table-row" key={`${entry.chain_id}:${entry.circuit_version}`}>
                <span>
                  <strong>v{entry.circuit_version}</strong>
                  <small>chain {entry.chain_id}</small>
                </span>
                <span className="mono" title={entry.verifier_address}>
                  {shortHash(entry.verifier_address)}
                </span>
                <span>
                  <strong className="mono" title={entry.circuit_artifact_hash}>
                    {shortHash(entry.circuit_artifact_hash)}
                  </strong>
                  <small className="mono" title={entry.verification_key_hash}>
                    VK {shortHash(entry.verification_key_hash)}
                  </small>
                </span>
                <span className="mono" title={entry.verifier_code_hash}>
                  {shortHash(entry.verifier_code_hash)}
                </span>
                <span>
                  <strong>Block {entry.registered_block}</strong>
                  <small title={entry.registration_tx_hash}>
                    {shortHash(entry.registration_tx_hash)} · {formatDate(entry.observed_at, { dateStyle: "medium", timeStyle: "short" })}
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>No verifier provenance indexed</strong>
            <span>
              Once CapacityVault emits VerifierProvenanceRegistered, the indexer will project the circuit artifact,
              verification key, verifier address, and runtime code hashes here.
            </span>
          </div>
        )}
      </section>

      <section className="panel table-panel">
        {(events ?? []).length ? (
          <div className="data-table chain-table">
            <div className="table-row table-head">
              <span>Block</span>
              <span>Event</span>
              <span>Transaction</span>
              <span>Contract</span>
              <span>Observed</span>
            </div>
            {(events ?? []).map((event) => (
              <div className="table-row" key={event.id}>
                <span>
                  <strong>{event.block_number}</strong>
                  <small>log {event.log_index}</small>
                </span>
                <span>{titleCase(event.event_name)}</span>
                <span className="mono">{shortHash(event.transaction_hash)}</span>
                <span className="mono">{shortHash(event.contract_address)}</span>
                <span>{formatDate(event.observed_at, { dateStyle: "medium", timeStyle: "short" })}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state large">
            <strong>No blockchain events indexed</strong>
            <span>Start the event indexer against the deployed Besu network to populate this read model.</span>
          </div>
        )}
      </section>
    </div>
  );
}
