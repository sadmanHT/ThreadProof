import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { getBlockchainStatus } from "@/lib/blockchain";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
const PIPELINE_STATES = ["prepared", "signed", "submitting", "submitted"];
const PROOF_ACTIVE_STATES = ["queued", "generating", "generated", "submitted"];
const CERTIFICATION_ACTIVE_STATES = ["prepared", "credential_submitted", "credential_confirmed", "capacity_submitted"];

type PipelineItem = {
  key: string;
  orderId: string;
  label: string;
  detail: string;
  status: string;
  updatedAt: string;
};

type WorkspaceRole = "buyer" | "factory" | "auditor" | "governance";
type QuickLink = readonly [href: string, title: string, description: string];

type RoleCopy = {
  role: WorkspaceRole;
  eyebrow: string;
  title: string;
  body: string;
  principle: string;
  quickLinks: readonly QuickLink[];
};

const roleCopies: Record<WorkspaceRole, RoleCopy> = {
  buyer: {
    role: "buyer",
    eyebrow: "BUYER WORKSPACE",
    title: "Authorize production without asking factories to reveal capacity.",
    body: "Create private orders, anchor buyer-signed versions, follow feasibility outcomes and keep every material amendment bound to a new canonical authorization.",
    principle: "A buyer authorizes an order version. A factory proves feasibility. Neither side gets to replace the chain's current state with an application claim.",
    quickLinks: [
      ["/app/orders/new", "Create private order", "Start with counterparty-confidential commercial metadata"],
      ["/app/orders", "Order portfolio", "Review drafts, signed versions and canonical status"],
      ["/app/subcontracts", "Authorized production paths", "Inspect buyer-consented parent-child factory relationships"],
      ["/app/audit", "Audit evidence", "Trace the chain events behind shared protocol state"],
    ],
  },
  factory: {
    role: "factory",
    eyebrow: "FACTORY WORKSPACE",
    title: "Spend certified capacity privately and exactly once.",
    body: "Work from your active certified opening, prove order feasibility with zero knowledge and follow the state transition until CapacityVault confirms the successor commitment.",
    principle: "Remaining capacity is factory-confidential witness material. Buyers receive a verifiable feasibility result, not the hidden opening.",
    quickLinks: [
      ["/app/capacity", "Capacity states", "Inspect active, pending and recertification-required commitments"],
      ["/app/proofs", "Proof operations", "Queue and follow Proof-of-Feasible-Capacity jobs"],
      ["/app/orders", "Assigned orders", "Review the order versions visible to this factory relationship"],
      ["/app/subcontracts", "Subcontract paths", "Inspect canonical parent-child production authorization"],
    ],
  },
  auditor: {
    role: "auditor",
    eyebrow: "AUDITOR WORKSPACE",
    title: "Certify the commitment, not a public capacity number.",
    body: "Prepare capacity certification, anchor credential provenance and reconcile CapacityCertified events while keeping exact capacity and randomness outside the consortium-visible interface.",
    principle: "ThreadProof can prove who issued a digital credential and whether it remains authorized. It cannot cryptographically prove that a physical-world inspection was correct.",
    quickLinks: [
      ["/app/capacity", "Certification workflow", "Prepare or resume confidential capacity certification"],
      ["/app/credentials", "Credential lifecycle", "Inspect issuance, suspension, restoration and revocation"],
      ["/app/organizations", "Consortium directory", "Review participant identity and visible credential metadata"],
      ["/app/governance", "Charter governance", "Participate through role-diverse on-chain authority"],
    ],
  },
  governance: {
    role: "governance",
    eyebrow: "CONSORTIUM WORKSPACE",
    title: "Exercise exceptional powers through attributable due process.",
    body: "Review committed actions, constituency thresholds, timelocks and execution evidence without turning the application database into a governance authority.",
    principle: "Consensus orders transactions. ThreadProofCharter determines whether exceptional protocol powers are authorized under the active policy.",
    quickLinks: [
      ["/app/governance", "Governance proposals", "Review approvals, timelocks and executable actions"],
      ["/app/audit", "Canonical audit trail", "Search attributable events and technical evidence"],
      ["/app/organizations", "Organizations", "Inspect consortium identity and status metadata"],
      ["/app/credentials", "Credentials", "Review verifiable authorization status across participants"],
    ],
  },
};

function workspaceRole(role: string | undefined): WorkspaceRole {
  if (role === "buyer" || role === "factory" || role === "auditor") return role;
  return "governance";
}

function projectedGovernanceState(proposal: { state: string; execute_after: string | null; expires_at: string | null }) {
  const now = Date.now();
  if (proposal.state === "timelocked" && proposal.execute_after && Date.parse(proposal.execute_after) <= now) return "executable";
  if (proposal.state === "pending" && proposal.expires_at && Date.parse(proposal.expires_at) < now) return "expired";
  return proposal.state;
}

export default async function DashboardPage() {
  const viewer = await requireConsortiumViewer();
  const primaryMembership = viewer.memberships[0];
  const perspective = workspaceRole(primaryMembership?.organization.role);
  const copy = roleCopies[perspective];
  const supabase = await createClient();
  const [
    ordersCount,
    credentialsCount,
    proofsCount,
    proposalsCount,
    recentOrders,
    recentEvents,
    authorizationJobs,
    cancellationJobs,
    proofJobs,
    capacityOpenings,
    certificationJobs,
    proposals,
    chain,
  ] = await Promise.all([
    supabase.from("purchase_orders").select("id", { count: "exact", head: true }),
    supabase.from("credentials").select("id", { count: "exact", head: true }),
    supabase.from("proof_jobs").select("id", { count: "exact", head: true }),
    supabase.from("governance_proposal_read_model").select("chain_proposal_id", { count: "exact", head: true }),
    supabase.from("purchase_orders").select("id,external_reference,title,status,updated_at,current_version").order("updated_at", { ascending: false }).limit(6),
    supabase.from("chain_events").select("id,event_name,transaction_hash,block_number,observed_at").order("block_number", { ascending: false }).limit(6),
    supabase.from("order_authorization_jobs").select("id,purchase_order_id,target_version,status,updated_at").in("status", PIPELINE_STATES).order("updated_at", { ascending: false }).limit(8),
    supabase.from("order_cancellation_jobs").select("id,purchase_order_id,expected_version,status,updated_at").in("status", PIPELINE_STATES).order("updated_at", { ascending: false }).limit(8),
    supabase.from("proof_jobs").select("id,status,circuit_version,created_at,error_code").order("created_at", { ascending: false }).limit(8),
    supabase.from("private_capacity_openings").select("id,status,period_id,process_id,circuit_version,updated_at").order("updated_at", { ascending: false }).limit(8),
    supabase.from("capacity_certification_jobs").select("id,status,period_label,process_label,updated_at,factory_organization_id").order("updated_at", { ascending: false }).limit(8),
    supabase.from("governance_proposal_read_model").select("chain_proposal_id,proposal_type,state,approvals_received,approvals_required,execute_after,expires_at,updated_at").order("updated_at", { ascending: false }).limit(8),
    getBlockchainStatus(),
  ]);

  const roles = [...viewer.roles].map(titleCase).join(" · ");
  const pipeline: PipelineItem[] = [
    ...(authorizationJobs.data ?? []).map((job) => ({
      key: `authorization-${job.id}`,
      orderId: job.purchase_order_id,
      label: `Authorize order version ${job.target_version}`,
      detail: "Buyer EIP-712 → OrderRegistry",
      status: job.status,
      updatedAt: job.updated_at,
    })),
    ...(cancellationJobs.data ?? []).map((job) => ({
      key: `cancellation-${job.id}`,
      orderId: job.purchase_order_id,
      label: `Cancel anchored version ${job.expected_version}`,
      detail: "Buyer EIP-712 → OrderRegistry",
      status: job.status,
      updatedAt: job.updated_at,
    })),
  ].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 6);

  const activeProofs = (proofJobs.data ?? []).filter((job) => PROOF_ACTIVE_STATES.includes(job.status)).length;
  const proofAttention = (proofJobs.data ?? []).filter((job) => job.status === "failed" || job.status === "stale").length;
  const activeCapacity = (capacityOpenings.data ?? []).filter((opening) => opening.status === "active").length;
  const capacityAttention = (capacityOpenings.data ?? []).filter((opening) => opening.status === "recertification_required").length;
  const activeCertification = (certificationJobs.data ?? []).filter((job) => CERTIFICATION_ACTIVE_STATES.includes(job.status)).length;
  const certificationAttention = (certificationJobs.data ?? []).filter((job) => job.status === "failed").length;
  const governanceRows = proposals.data ?? [];
  const executableGovernance = governanceRows.filter((proposal) => projectedGovernanceState(proposal) === "executable").length;
  const pendingGovernance = governanceRows.filter((proposal) => ["pending", "timelocked"].includes(projectedGovernanceState(proposal))).length;
  const draftOrders = (recentOrders.data ?? []).filter((order) => order.status === "draft").length;
  const feasibleOrders = (recentOrders.data ?? []).filter((order) => order.status === "feasible" || order.status === "accepted").length;

  const roleStats = perspective === "buyer"
    ? [
        ["Visible orders", ordersCount.count ?? 0, "relationship-scoped portfolio"],
        ["Recent private drafts", draftOrders, "awaiting buyer authorization"],
        ["Actions in flight", pipeline.length, "EIP-712 → OrderRegistry"],
        ["Feasible / accepted", feasibleOrders, "recent visible orders"],
      ] as const
    : perspective === "factory"
      ? [
          ["Active capacity states", activeCapacity, "current private openings"],
          ["Proofs in progress", activeProofs, "queued through submitted"],
          ["Proof attention", proofAttention, "failed or stale"],
          ["Recertification needed", capacityAttention, "visible capacity states"],
        ] as const
      : perspective === "auditor"
        ? [
            ["Certification in progress", activeCertification, "staged chain reconciliation"],
            ["Certification attention", certificationAttention, "failed staging jobs"],
            ["Credentials", credentialsCount.count ?? 0, "consortium-visible metadata"],
            ["Governance proposals", proposalsCount.count ?? 0, "Charter read model"],
          ] as const
        : [
            ["Governance proposals", proposalsCount.count ?? 0, "indexed Charter state"],
            ["Pending / timelocked", pendingGovernance, "due process underway"],
            ["Executable", executableGovernance, "threshold + timelock satisfied"],
            ["Credentials", credentialsCount.count ?? 0, "authorization metadata"],
          ] as const;

  return (
    <div className={`workspace-page dashboard-page role-workspace role-${perspective}`}>
      <header className="role-workspace-hero">
        <div className="role-workspace-copy">
          <div className="role-context"><span className="kicker">{copy.eyebrow}</span>{primaryMembership ? <span className="role-org-pill">{primaryMembership.organization.display_name}</span> : null}</div>
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <div className="role-access-row"><span>{roles || "Consortium member"}</span><i aria-hidden="true" /> <span>{primaryMembership ? titleCase(primaryMembership.member_role) : "Viewer"}</span></div>
        </div>
        <div className="role-trust-card"><span className="kicker">AUTHORITY BOUNDARY</span><strong>{copy.principle}</strong><div className={`chain-pill ${chain.online ? "online" : "offline"}`}><span />{chain.configured ? (chain.online ? `Network online · block ${chain.blockNumber}` : "Network unavailable") : "RPC not configured"}</div></div>
      </header>

      <section className="role-action-grid" aria-label={`${copy.eyebrow} quick actions`}>
        {copy.quickLinks.map(([href, title, description], index) => <Link href={href} className="role-action-card" key={href}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{title}</strong><small>{description}</small></div><b aria-hidden="true">→</b></Link>)}
      </section>

      <section className="role-stat-grid">
        {roleStats.map(([label, value, detail]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>)}
      </section>

      {perspective === "buyer" ? <section className="dashboard-grid role-dashboard-grid">
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">ORDER PORTFOLIO</span><h2>Recent buyer work</h2></div><Link href="/app/orders">View all →</Link></div>{(recentOrders.data ?? []).length ? <div className="record-list">{(recentOrders.data ?? []).map((order) => <Link className="record-row" href={`/app/orders/${order.id}`} key={order.id}><div><strong>{order.title || order.external_reference}</strong><span>{order.external_reference} · version {order.current_version} · updated {formatDate(order.updated_at)}</span></div><StatusBadge value={order.status} /></Link>)}</div> : <div className="empty-state"><strong>No visible orders yet</strong><span>Create a private draft when an active factory counterparty is ready.</span></div>}</article>
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">BUYER SIGNATURE PIPELINE</span><h2>Actions in flight</h2></div><Link href="/app/orders">Open orders →</Link></div>{pipeline.length ? <div className="record-list">{pipeline.map((item) => <Link className="record-row" href={`/app/orders/${item.orderId}`} key={item.key}><div><strong>{item.label}</strong><span>{item.detail} · updated {formatDate(item.updatedAt)}</span></div><StatusBadge value={item.status} /></Link>)}</div> : <div className="empty-state"><strong>No buyer transactions in flight</strong><span>Prepared, signed, relaying and submitted order actions appear here until canonical chain events reconcile them.</span></div>}</article>
      </section> : null}

      {perspective === "factory" ? <section className="dashboard-grid role-dashboard-grid">
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">PRIVATE CAPACITY STATE</span><h2>Recent openings</h2></div><Link href="/app/capacity">Capacity →</Link></div>{(capacityOpenings.data ?? []).length ? <div className="record-list">{(capacityOpenings.data ?? []).map((opening) => <Link className="record-row" href="/app/capacity" key={opening.id}><div><strong>{opening.period_id} · {titleCase(opening.process_id)}</strong><span>circuit v{opening.circuit_version} · updated {formatDate(opening.updated_at)}</span></div><StatusBadge value={opening.status} /></Link>)}</div> : <div className="empty-state"><strong>No private capacity openings visible</strong><span>Capacity appears only after an auditor-backed certification is reconciled to a matching on-chain event.</span></div>}</article>
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">ZERO-KNOWLEDGE EXECUTION</span><h2>Recent proof jobs</h2></div><Link href="/app/proofs">Proofs →</Link></div>{(proofJobs.data ?? []).length ? <div className="record-list">{(proofJobs.data ?? []).map((job) => <Link className="record-row" href="/app/proofs" key={job.id}><div><strong>PoFC · circuit v{job.circuit_version}</strong><span>{job.error_code ? `${job.error_code} · ` : ""}created {formatDate(job.created_at)}</span></div><StatusBadge value={job.status} /></Link>)}</div> : <div className="empty-state"><strong>No proof jobs visible</strong><span>Queue Proof-of-Feasible-Capacity only after an authorized order version and active private opening are both available.</span></div>}</article>
      </section> : null}

      {perspective === "auditor" ? <section className="dashboard-grid role-dashboard-grid">
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">CAPACITY CERTIFICATION</span><h2>Reconciliation queue</h2></div><Link href="/app/capacity">Certification →</Link></div>{(certificationJobs.data ?? []).length ? <div className="record-list">{(certificationJobs.data ?? []).map((job) => <Link className="record-row" href="/app/capacity" key={job.id}><div><strong>{job.period_label} · {titleCase(job.process_label)}</strong><span>updated {formatDate(job.updated_at)}</span></div><StatusBadge value={job.status} /></Link>)}</div> : <div className="empty-state"><strong>No certification jobs visible</strong><span>Prepared and reconciled certification work appears here without disclosing the factory's exact capacity.</span></div>}</article>
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">AUDITOR DUTY</span><h2>What this role attests</h2></div><Link href="/app/credentials">Credentials →</Link></div><div className="role-duty-list"><div><span>01</span><p><strong>Assess off-chain evidence.</strong><small>Physical-world methodology remains an auditor responsibility, not a blockchain inference.</small></p></div><div><span>02</span><p><strong>Issue attributable credential state.</strong><small>CredentialRegistry records who issued it, its scope and whether it remains authorized.</small></p></div><div><span>03</span><p><strong>Bind confidential capacity to a commitment.</strong><small>The exact opening stays encrypted while the commitment becomes verifiable protocol state.</small></p></div></div></article>
      </section> : null}

      {perspective === "governance" ? <section className="dashboard-grid role-dashboard-grid">
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">CHARTER DUE PROCESS</span><h2>Recent proposals</h2></div><Link href="/app/governance">Governance →</Link></div>{governanceRows.length ? <div className="record-list">{governanceRows.map((proposal) => { const state = projectedGovernanceState(proposal); return <Link className="record-row" href={`/app/governance/${proposal.chain_proposal_id}`} key={proposal.chain_proposal_id}><div><strong>{titleCase(proposal.proposal_type)}</strong><span>{proposal.approvals_received} / {proposal.approvals_required ?? "—"} approvals · updated {formatDate(proposal.updated_at)}</span></div><StatusBadge value={state} /></Link>; })}</div> : <div className="empty-state"><strong>No governance proposals indexed</strong><span>Canonical Charter proposals appear here after the event indexer reconciles them.</span></div>}</article>
        <article className="panel activity-panel"><div className="panel-heading"><div><span className="kicker">GOVERNANCE GUARANTEE</span><h2>What the application cannot do</h2></div><Link href="/app/audit">Audit →</Link></div><div className="role-duty-list"><div><span>01</span><p><strong>It cannot manufacture an approval.</strong><small>Constituency authority is evaluated from the connected wallet and Registry identity.</small></p></div><div><span>02</span><p><strong>It cannot shorten a timelock.</strong><small>Executable timing is committed and enforced by ThreadProofCharter.</small></p></div><div><span>03</span><p><strong>It cannot reveal a protected identity by itself.</strong><small>Only a parameter-bound governed disclosure action can make that exceptional power executable.</small></p></div></div></article>
      </section> : null}

      <section className="panel full-dashboard-panel activity-panel role-chain-panel">
        <div className="panel-heading"><div><span className="kicker">CANONICAL MIRROR</span><h2>Recent protocol events</h2></div><Link href="/app/audit">Open audit trail →</Link></div>
        {(recentEvents.data ?? []).length ? <div className="chain-event-grid">{(recentEvents.data ?? []).map((event) => <div className="chain-event-card" key={event.id}><span className="event-dot" /><div><strong>{titleCase(event.event_name)}</strong><span>Block {event.block_number}</span></div><code>{shortHash(event.transaction_hash)}</code></div>)}</div> : <div className="empty-state"><strong>No indexed events</strong><span>The indexer read model is empty. Direct chain validation remains required for critical writes.</span></div>}
      </section>

      <section className="protocol-banner"><div><span className="kicker">ALL MEMBERSHIPS</span><h2>{roles || "Consortium member"}</h2></div><p>This page is composed around your primary organization perspective. Additional memberships can broaden visible workflows, but RLS and on-chain organization authority still decide what data and actions are actually available.</p></section>
    </div>
  );
}
