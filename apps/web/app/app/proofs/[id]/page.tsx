import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import type { Json } from "@/lib/database.types";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lifecycle = ["queued", "generating", "generated", "submitted", "confirmed"] as const;

function lifecycleIndex(status: string) {
  const index = lifecycle.indexOf(status as (typeof lifecycle)[number]);
  return index < 0 ? -1 : index;
}

function scalarEntries(value: Json | null) {
  if (!value || Array.isArray(value) || typeof value !== "object") return [] as [string, string][];
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return [[key, String(item)] as [string, string]];
    return [];
  });
}

export default async function ProofDetailPage({ params }: Props) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || !["buyer", "factory"].includes(active.organization.role)) notFound();

  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data: job } = await supabase.from("proof_jobs").select("*").eq("id", id).maybeSingle();
  if (!job) notFound();

  const [{ data: version }, { data: verifierRows }] = await Promise.all([
    supabase.from("order_versions").select("id,purchase_order_id,version,order_commitment,policy_hash,version_hash,production_period_start,production_period_end,chain_tx_hash,chain_block_number").eq("id", job.order_version_id).maybeSingle(),
    supabase.from("verifier_provenance_read_model").select("chain_id,circuit_version,verifier_address,circuit_artifact_hash,verification_key_hash,verifier_code_hash,registration_tx_hash,registered_block,observed_at").eq("circuit_version", job.circuit_version).order("registered_block", { ascending: false }).limit(1),
  ]);
  const { data: order } = version
    ? await supabase.from("purchase_orders").select("id,external_reference,title,status,current_version,chain_order_id,buyer_organization_id,factory_organization_id").eq("id", version.purchase_order_id).maybeSingle()
    : { data: null };

  const factoryContext = active.organization.role === "factory" && active.organization_id === job.factory_organization_id && active.organization_id === order?.factory_organization_id;
  const buyerContext = active.organization.role === "buyer" && active.organization_id === order?.buyer_organization_id;
  if (!factoryContext && !buyerContext) notFound();

  const { data: opening } = factoryContext
    ? await supabase.from("private_capacity_openings").select("id,period_id,process_id,chain_state_key,policy_hash,circuit_version,status,last_chain_block,updated_at").eq("id", job.capacity_opening_id).eq("factory_organization_id", active.organization_id).maybeSingle()
    : { data: null };
  const verifier = verifierRows?.[0] ?? null;
  const current = lifecycleIndex(job.status);
  const exception = job.status === "failed" || job.status === "stale";
  const publicInputs = scalarEntries(job.public_inputs);

  return <div className="workspace-page">
    <div className="breadcrumb-row"><Link href="/app/proofs">Proofs</Link><span>›</span><span>{shortHash(job.id, 8, 6)}</span></div>
    <header className="proof-detail-hero"><div><span className="kicker">PROOF-OF-FEASIBLE-CAPACITY</span><h1>{order?.title || order?.external_reference || "Proof evidence"}</h1><p>{order?.external_reference ? `${order.external_reference} · ` : ""}{version ? `order version ${version.version} · ` : ""}circuit v{job.circuit_version} · active context {active.organization.display_name}</p></div><StatusBadge value={job.status} /></header>

    {exception ? <div className="alert alert-error"><strong>{job.error_code || titleCase(job.status)}</strong>{job.error_detail ? ` · ${job.error_detail}` : " · No canonical capacity transition was accepted for this job."}</div> : null}

    <section className="panel proof-evidence-progress"><div className="panel-heading"><div><span className="kicker">EXECUTION STATE</span><h2>Cryptographic lifecycle</h2></div></div><div className="proof-progress proof-progress-large">{lifecycle.map((stage, index) => <span className={current >= 0 && index < current ? "done" : current === index ? "current" : ""} key={stage}><i />{stage}</span>)}</div><p className="form-help">Generated means a proof exists. Submitted means a transaction is in flight. Only confirmed means CapacityVault accepted the proof against the current capacity state.</p></section>

    <section className="proof-evidence-grid">
      <article className="panel"><div className="panel-heading"><div><span className="kicker">BOUND STATEMENTS</span><h2>Order and capacity context</h2></div></div><dl className="definition-grid"><div><dt>Order</dt><dd>{order?.external_reference ?? shortHash(job.order_version_id)}</dd></div><div><dt>Order status</dt><dd>{order ? <StatusBadge value={order.status} /> : "Not visible"}</dd></div><div><dt>Order version</dt><dd>{version ? `v${version.version}` : "Not visible"}</dd></div><div><dt>Order commitment</dt><dd className="mono">{version ? shortHash(version.order_commitment) : "—"}</dd></div><div><dt>Capacity period</dt><dd>{opening?.period_id ?? "Factory-confidential"}</dd></div><div><dt>Process</dt><dd>{opening ? titleCase(opening.process_id) : "Factory-confidential"}</dd></div><div className="wide"><dt>Capacity state key</dt><dd className="mono hash-full">{opening?.chain_state_key ?? "Factory-confidential in buyer context"}</dd></div><div><dt>Opening mirror state</dt><dd>{opening ? <StatusBadge value={opening.status} /> : "Not exposed"}</dd></div><div><dt>Last opening block</dt><dd>{opening?.last_chain_block ?? "Not exposed"}</dd></div></dl></article>

      <article className="panel trust-panel"><span className="kicker">PRIVACY BOUNDARY</span><h2>The witness is not on this page.</h2><p>ThreadProof stores encrypted remaining-capacity and randomness separately. Factory context may inspect its own indexed opening reference; buyer context receives the proof statements and chain result without the private opening mirror. This page never queries <span className="mono">proof_job_private_state</span>.</p><div className="privacy-access-list"><span className="privacy-chip private">Witness concealed</span><span className="privacy-chip shared">Public inputs verifiable</span><span className="privacy-chip consortium">Chain result attributable</span></div></article>
    </section>

    <section className="proof-evidence-grid">
      <article className="panel"><div className="panel-heading"><div><span className="kicker">PUBLIC INPUTS</span><h2>Verifier-facing statements</h2></div><span className="panel-count">{publicInputs.length}</span></div>{publicInputs.length ? <div className="evidence-kv-list">{publicInputs.map(([key, value]) => <div key={key}><span>{titleCase(key)}</span><code title={value}>{value}</code></div>)}</div> : <div className="empty-state"><strong>No public inputs stored yet</strong><span>A queued or early generating job may not have verifier-facing statements materialized yet.</span></div>}<details className="technical-disclosure"><summary>Raw public-input JSON</summary><pre>{JSON.stringify(job.public_inputs, null, 2)}</pre></details></article>

      <article className="panel"><div className="panel-heading"><div><span className="kicker">VERIFIER PROVENANCE</span><h2>Circuit binding</h2></div></div>{verifier ? <dl className="definition-grid"><div><dt>Circuit version</dt><dd>v{verifier.circuit_version}</dd></div><div><dt>Registered block</dt><dd>{verifier.registered_block.toLocaleString()}</dd></div><div className="wide"><dt>Verifier address</dt><dd className="mono hash-full">{verifier.verifier_address}</dd></div><div className="wide"><dt>Circuit artifact hash</dt><dd className="mono hash-full">{verifier.circuit_artifact_hash}</dd></div><div className="wide"><dt>Verification-key hash</dt><dd className="mono hash-full">{verifier.verification_key_hash}</dd></div><div className="wide"><dt>Verifier runtime-code hash</dt><dd className="mono hash-full">{verifier.verifier_code_hash}</dd></div><div className="wide"><dt>Registration transaction</dt><dd className="mono hash-full">{verifier.registration_tx_hash}</dd></div></dl> : <div className="empty-state"><strong>No verifier provenance indexed for circuit v{job.circuit_version}</strong><span>Proof acceptance must fail closed if the deployed verifier cannot be bound to the expected circuit and verification key provenance.</span></div>}</article>
    </section>

    <section className="panel"><div className="panel-heading"><div><span className="kicker">JOB AUDIT</span><h2>Execution metadata</h2></div></div><dl className="definition-grid proof-audit-grid"><div><dt>Job id</dt><dd className="mono hash-full">{job.id}</dd></div><div><dt>Factory organization</dt><dd className="mono">{shortHash(job.factory_organization_id)}</dd></div><div><dt>Created</dt><dd>{formatDate(job.created_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Started</dt><dd>{formatDate(job.started_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Completed</dt><dd>{formatDate(job.completed_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div><div><dt>Chain block</dt><dd>{job.chain_block_number ?? "Not confirmed"}</dd></div><div className="wide"><dt>Chain transaction</dt><dd className="mono hash-full">{job.chain_tx_hash ?? "Not submitted / not visible"}</dd></div></dl>{job.proof ? <details className="technical-disclosure"><summary>Stored Groth16 proof payload</summary><pre>{JSON.stringify(job.proof, null, 2)}</pre></details> : null}</section>

    <p className="footnote">Active organization context controls which relationship is composed in the application. A proof object still is not a capacity authorization by itself; canonical feasibility depends on successful verification against the provenance-bound verifier and current CapacityVault state.</p>
  </div>;
}
