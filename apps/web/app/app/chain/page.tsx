import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

type IndexerHealth = {
  chain_id: number | string;
  last_block_number: number | string;
  last_block_hash: string;
  status: string;
  error_code: string | null;
  updated_at: string;
};

function toBigInt(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function ageLabel(seconds: number | null) {
  if (seconds === null) return "age unavailable";
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  return `${Math.floor(seconds / 3600)}h old`;
}

export default async function ChainPage() {
  await requireConsortiumViewer();
  const supabase = await createClient();

  const [eventsResult, verifierResult, indexerResult, chain] = await Promise.all([
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
    (supabase as any).rpc("get_chain_indexer_health"),
    getBlockchainStatus(),
  ]);

  const events = eventsResult.data ?? [];
  const verifierProvenance = verifierResult.data ?? [];
  const cursorRows = (indexerResult.data ?? []) as IndexerHealth[];
  const cursor = cursorRows.find((item) => Number(item.chain_id) === chain.chainId) ?? cursorRows[0] ?? null;
  const chainHead = toBigInt(chain.blockNumber);
  const indexedHead = toBigInt(cursor?.last_block_number);
  const indexerLag = chainHead !== null && indexedHead !== null && chainHead >= indexedHead
    ? chainHead - indexedHead
    : null;
  const indexerQuarantined = cursor?.status === "reorg_detected";
  const staleHead = chain.blockAgeSeconds !== null && chain.blockAgeSeconds > 60;
  const zeroPeers = chain.peerCount === 0;
  const contractProblems = chain.contracts.filter((contract) => !contract.validAddress || contract.hasCode !== true);

  return (
    <div className="workspace-page">
      <header className="page-header">
        <div>
          <span className="kicker">BESU OPERATIONS · CANONICAL VERIFICATION</span>
          <h1>Consortium chain</h1>
          <p>
            Live RPC truth and rebuildable indexer state are shown separately. Protocol authorization still comes from
            the permissioned EVM contracts, signatures, governance rules, and ZK verification—not from this dashboard.
          </p>
        </div>
        <div className={`chain-pill ${chain.online ? "online" : "offline"}`}>
          <span />
          {chain.configured
            ? chain.online
              ? `Chain ${chain.chainId} · block ${chain.blockNumber}`
              : chain.error ?? "RPC unavailable"
            : "RPC not configured"}
        </div>
      </header>

      <section className="chain-health-strip" aria-label="Blockchain operations health">
        <div className="chain-health-card">
          <span>Canonical head</span>
          <strong>{chain.blockNumber ? `#${chain.blockNumber}` : "Unavailable"}</strong>
          <small>{chain.online ? `${ageLabel(chain.blockAgeSeconds)} · ${shortHash(chain.blockHash)}` : "No canonical head available"}</small>
        </div>
        <div className="chain-health-card">
          <span>QBFT connectivity</span>
          <strong className="chain-status-line">
            <i className={`chain-status-dot ${chain.online && !zeroPeers ? "good" : chain.online ? "warn" : "bad"}`} />
            {chain.peerCount === null ? "Peers unavailable" : `${chain.peerCount} peer${chain.peerCount === 1 ? "" : "s"}`}
          </strong>
          <small>{chain.syncing === null ? "Sync state unavailable" : chain.syncing ? "Node reports syncing" : "Node reports steady state"}</small>
        </div>
        <div className="chain-health-card">
          <span>Runtime contracts</span>
          <strong className="chain-status-line">
            <i className={`chain-status-dot ${chain.contractsReady ? "good" : "warn"}`} />
            {chain.contractsDeployed}/{chain.contracts.length} deployed
          </strong>
          <small>{chain.contractsConfigured}/{chain.contracts.length} addresses configured</small>
        </div>
        <div className="chain-health-card">
          <span>Read-model indexer</span>
          <strong className="chain-status-line">
            <i className={`chain-status-dot ${indexerQuarantined ? "bad" : indexerLag === 0n ? "good" : "warn"}`} />
            {cursor ? `#${cursor.last_block_number}` : "No cursor"}
          </strong>
          <small>
            {indexerQuarantined
              ? `Quarantined${cursor?.error_code ? ` · ${cursor.error_code}` : ""}`
              : indexerLag === null
                ? "Lag unavailable"
                : `${indexerLag.toString()} block${indexerLag === 1n ? "" : "s"} behind RPC head`}
          </small>
        </div>
      </section>

      {(chain.error || chain.syncing || staleHead || zeroPeers || !chain.contractsReady || indexerQuarantined) && (
        <section className="chain-alert-stack" aria-label="Blockchain warnings">
          {chain.error && <p className="alert alert-error">Canonical RPC: {chain.error}</p>}
          {indexerQuarantined && (
            <p className="alert alert-error">
              The rebuildable indexer cursor is quarantined after a canonicality failure. Do not rely on projected
              read models until the cursor is explicitly reconciled or rebuilt.
            </p>
          )}
          {chain.syncing && <p className="alert alert-error">The connected consortium node reports that it is still synchronizing.</p>}
          {staleHead && <p className="alert alert-error">The latest block is {ageLabel(chain.blockAgeSeconds)}. Check validator/node liveness before authorizing new work.</p>}
          {zeroPeers && <p className="alert alert-error">The connected node reports zero peers. Treat the node as isolated until consortium connectivity is restored.</p>}
          {!chain.contractsReady && (
            <p className="alert alert-error">
              Runtime contract inventory is incomplete: {contractProblems.length} expected contract{contractProblems.length === 1 ? "" : "s"} are missing configuration, have an invalid address, or have no deployed bytecode.
            </p>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">LIVE RPC RUNTIME</span>
            <h2>Protocol contract inventory</h2>
          </div>
          {chain.clientVersion && <span className="badge neutral">{chain.clientVersion}</span>}
        </div>
        <div className="chain-contract-grid">
          {chain.contracts.map((contract) => {
            const ready = contract.validAddress && contract.hasCode === true;
            return (
              <article className={`chain-contract-card ${ready ? "ready" : "problem"}`} key={contract.key}>
                <div className="chain-contract-head">
                  <strong>{contract.name}</strong>
                  <span className={`badge ${ready ? "success" : "warning"}`}>
                    {ready ? "Bytecode verified" : !contract.configured ? "Not configured" : !contract.validAddress ? "Invalid address" : "No bytecode"}
                  </span>
                </div>
                <p>{contract.purpose}</p>
                <div className="chain-contract-address mono" title={contract.address ?? undefined}>
                  {contract.address ?? "No runtime address"}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="chain-trust-note">
        The event timeline below is a convenience projection. The worker verifies confirmed block hashes and fails closed
        on reorgs, but the database remains rebuildable. Use the transaction verification view to re-check a transaction
        receipt and its containing block directly against the configured consortium RPC.
      </div>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <span className="kicker">ZK VERIFIER PROVENANCE</span>
            <h2>Immutable circuit-version bindings</h2>
          </div>
        </div>
        {verifierProvenance.length ? (
          <div className="data-table chain-table">
            <div className="table-row table-head">
              <span>Version</span>
              <span>Verifier</span>
              <span>Circuit / VK</span>
              <span>Runtime code</span>
              <span>Registration</span>
            </div>
            {verifierProvenance.map((entry) => (
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
                  <small>
                    <Link className="hash-link mono" href={`/app/chain/transactions/${entry.registration_tx_hash}`} title={entry.registration_tx_hash}>
                      {shortHash(entry.registration_tx_hash)}
                    </Link>
                    {" · "}{formatDate(entry.observed_at, { dateStyle: "medium", timeStyle: "short" })}
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
        <div className="panel-heading">
          <div>
            <span className="kicker">CONFIRMED EVENT PROJECTION</span>
            <h2>Recent protocol activity</h2>
          </div>
          <span className="badge neutral">Latest {events.length}</span>
        </div>
        {events.length ? (
          <div className="data-table chain-table">
            <div className="table-row table-head">
              <span>Block</span>
              <span>Event</span>
              <span>Transaction</span>
              <span>Contract</span>
              <span>Observed</span>
            </div>
            {events.map((event) => (
              <div className="table-row" key={event.id}>
                <span>
                  <strong>{event.block_number}</strong>
                  <small>log {event.log_index}</small>
                </span>
                <span>{titleCase(event.event_name)}</span>
                <span className="mono">
                  <Link className="hash-link" href={`/app/chain/transactions/${event.transaction_hash}`} title={event.transaction_hash}>
                    {shortHash(event.transaction_hash)}
                  </Link>
                </span>
                <span className="mono" title={event.contract_address}>{shortHash(event.contract_address)}</span>
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
