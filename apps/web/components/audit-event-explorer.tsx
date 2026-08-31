"use client";

import { useEffect, useMemo, useState } from "react";

type AuditEvent = {
  id: number;
  blockNumber: number;
  transactionHash: string;
  contractAddress: string;
  eventName: string;
  logIndex: number;
  observedAt: string;
  indexedValues: unknown;
  data: unknown;
};

type Props = { events: AuditEvent[] };

function short(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function titleCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function category(name: string) {
  if (/capacity/i.test(name)) return "Capacity";
  if (/credential/i.test(name)) return "Credential";
  if (/order/i.test(name)) return "Order";
  if (/subcontract/i.test(name)) return "Subcontract";
  if (/proposal|governance|charter|disclosure/i.test(name)) return "Governance";
  if (/verifier|policy/i.test(name)) return "Protocol";
  return "Network";
}

function dateTime(value: string) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

export function AuditEventExplorer({ events }: Props) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const eventTypes = useMemo(() => [...new Set(events.map((event) => event.eventName))].sort(), [events]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      if (type !== "all" && event.eventName !== type) return false;
      if (!needle) return true;
      return `${event.eventName} ${event.transactionHash} ${event.contractAddress} ${event.blockNumber} ${JSON.stringify(event.indexedValues)} ${JSON.stringify(event.data)}`.toLowerCase().includes(needle);
    });
  }, [events, query, type]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  async function copyTransaction() {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.transactionHash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return <>
    <section className="audit-toolbar"><label className="audit-search"><span className="sr-only">Search audit events</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event, transaction, block or identifier" /></label><label><span className="sr-only">Filter event type</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="all">All event types</option>{eventTypes.map((eventType) => <option value={eventType} key={eventType}>{titleCase(eventType)}</option>)}</select></label><span className="audit-result-count">{filtered.length} events</span></section>

    <section className="panel audit-panel">
      {filtered.length ? <div className="audit-list"><div className="audit-row audit-head"><span>Event</span><span>Category</span><span>Block</span><span>Transaction</span><span>Observed</span></div>{filtered.map((event) => <button type="button" className="audit-row audit-event-row" onClick={() => setSelected(event)} key={event.id}><span><strong>{titleCase(event.eventName)}</strong><small>log {event.logIndex}</small></span><span><i className={`audit-category ${category(event.eventName).toLowerCase()}`} />{category(event.eventName)}</span><span><strong>#{event.blockNumber.toLocaleString()}</strong></span><span className="mono">{short(event.transactionHash)}</span><span>{dateTime(event.observedAt)}</span></button>)}</div> : <div className="empty-state large"><strong>No events match this view</strong><span>Clear the search or select a broader event type. The audit trail remains a read-only projection of canonical chain events.</span></div>}
    </section>

    {selected ? <><button type="button" className="audit-drawer-backdrop" aria-label="Close event details" onClick={() => setSelected(null)} /><aside className="audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-event-title"><header><div><span className="kicker">CANONICAL EVENT</span><h2 id="audit-event-title">{titleCase(selected.eventName)}</h2><p>Block {selected.blockNumber.toLocaleString()} · log {selected.logIndex}</p></div><button type="button" className="drawer-close" aria-label="Close details" onClick={() => setSelected(null)}>×</button></header><div className="drawer-section"><span className="drawer-label">Transaction</span><div className="copy-field"><code>{selected.transactionHash}</code><button type="button" onClick={copyTransaction}>{copied ? "Copied" : "Copy"}</button></div></div><div className="drawer-definition-grid"><div><span>Category</span><strong>{category(selected.eventName)}</strong></div><div><span>Observed</span><strong>{dateTime(selected.observedAt)}</strong></div><div><span>Contract</span><strong className="mono" title={selected.contractAddress}>{short(selected.contractAddress)}</strong></div><div><span>Block</span><strong>#{selected.blockNumber.toLocaleString()}</strong></div></div><details className="technical-disclosure"><summary>Indexed event parameters</summary><pre>{JSON.stringify(selected.indexedValues, null, 2)}</pre></details><details className="technical-disclosure"><summary>Decoded event data</summary><pre>{JSON.stringify(selected.data, null, 2)}</pre></details><div className="drawer-trust"><strong>Read-only audit evidence</strong><p>This panel is reconstructed from indexed chain events. It does not create, approve or mutate protocol state.</p></div></aside></> : null}
  </>;
}
