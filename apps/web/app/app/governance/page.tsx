import Link from "next/link";
import type { Address, Hex } from "viem";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { GovernanceConsole } from "@/components/governance-console";
import { FactoryOnboardingConsole, type FactoryOnboardingReview } from "@/components/factory-onboarding-console";
import type { GovernanceTargetOrganization } from "@/lib/governance-chain";

export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const GOVERNANCE_ROLES = new Set([
  "buyer",
  "factory",
  "auditor",
  "regulator",
  "industry",
  "labor_representative",
  "independent",
]);
const FACTORY_REVIEW_ROLES = new Set(["factory", "industry", "auditor", "independent"]);

function projectedState(proposal: {
  state: string;
  execute_after: string | null;
  expires_at: string | null;
}) {
  const now = Date.now();
  if (proposal.state === "timelocked" && proposal.execute_after && Date.parse(proposal.execute_after) <= now) {
    return "executable";
  }
  if (proposal.state === "pending" && proposal.expires_at && Date.parse(proposal.expires_at) < now) {
    return "expired";
  }
  return proposal.state;
}

export default async function GovernancePage() {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: proposals }, { data: organizations }, { data: onboardingRequests }] = await Promise.all([
    supabase.from("governance_proposal_read_model").select("*").order("updated_at", { ascending: false }),
    supabase.from("organizations").select("chain_organization_id,display_name,role,status").order("display_name"),
    supabase
      .from("organization_onboarding_requests")
      .select("id,legal_name,display_name,country_code,notes,primary_account,proposed_chain_organization_id,metadata_hash,action_hash,chain_proposal_id,status")
      .eq("requested_role", "factory")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);

  const charterAddressRaw = process.env.THREADPROOF_CHARTER_ADDRESS?.trim() ?? "";
  const chainIdRaw = process.env.NEXT_PUBLIC_THREADPROOF_CHAIN_ID ?? process.env.THREADPROOF_CHAIN_ID ?? "";
  const chainId = Number(chainIdRaw);
  const charterConfigured = ADDRESS.test(charterAddressRaw) && Number.isSafeInteger(chainId) && chainId > 0;
  const canUseGovernanceConsole = viewer.memberships.some((membership) =>
    membership.active &&
    membership.organization.status === "active" &&
    GOVERNANCE_ROLES.has(membership.organization.role) &&
    hasOperationalRole(membership),
  );
  const canReviewFactories = viewer.memberships.some((membership) =>
    membership.active &&
    membership.organization.status === "active" &&
    FACTORY_REVIEW_ROLES.has(membership.organization.role) &&
    hasOperationalRole(membership),
  );
  const targetOrganizations: GovernanceTargetOrganization[] = (organizations ?? [])
    .filter((organization) => HEX_32.test(organization.chain_organization_id))
    .map((organization) => ({
      chainOrganizationId: organization.chain_organization_id as Hex,
      displayName: organization.display_name,
      role: organization.role,
      status: organization.status,
    }));
  const rows = proposals ?? [];
  const proposalMap = new Map(rows.map((proposal) => [proposal.chain_proposal_id.toLowerCase(), proposal]));
  const factoryReviews: FactoryOnboardingReview[] = (onboardingRequests ?? []).flatMap((request) => {
    if (
      !request.primary_account ||
      !request.proposed_chain_organization_id ||
      !request.metadata_hash ||
      !request.action_hash ||
      !ADDRESS.test(request.primary_account) ||
      !HEX_32.test(request.proposed_chain_organization_id) ||
      !HEX_32.test(request.metadata_hash) ||
      !HEX_32.test(request.action_hash) ||
      (request.chain_proposal_id != null && !HEX_32.test(request.chain_proposal_id))
    ) return [];

    const proposal = request.chain_proposal_id
      ? proposalMap.get(request.chain_proposal_id.toLowerCase())
      : undefined;
    return [{
      id: request.id,
      legalName: request.legal_name,
      displayName: request.display_name,
      countryCode: request.country_code,
      notes: request.notes,
      primaryAccount: request.primary_account as Address,
      proposedChainOrganizationId: request.proposed_chain_organization_id as Hex,
      metadataHash: request.metadata_hash as Hex,
      actionHash: request.action_hash as Hex,
      chainProposalId: request.chain_proposal_id as Hex | null,
      proposalState: proposal ? projectedState(proposal) : null,
    }];
  });
  const states = rows.map(projectedState);
  const awaitingApprovals = states.filter((state) => state === "pending").length;
  const timelocked = states.filter((state) => state === "timelocked").length;
  const executable = states.filter((state) => state === "executable").length;
  const executed = states.filter((state) => state === "executed").length;

  return (
    <div className="workspace-page">
      <header className="page-header"><div><span className="kicker">THREADPROOF CHARTER</span><h1>Governance</h1><p>Consensus orders valid transactions; the Charter determines who is authorized to exercise exceptional protocol powers through role-diverse approvals, committed action parameters and timelocks.</p></div></header>

      <section className="privacy-banner"><span className="privacy-icon">◇</span><div><strong>The chain is the governance authority.</strong><p>This screen is an event-derived audit view. A Supabase row cannot create an approval, satisfy a threshold, shorten a timelock, admit a factory, or execute a Charter action.</p></div></section>

      <section className="governance-overview-grid">
        <article><span>Awaiting approvals</span><strong>{awaitingApprovals}</strong><small>threshold not yet satisfied</small></article>
        <article><span>Timelocked</span><strong>{timelocked}</strong><small>approved but not executable yet</small></article>
        <article className={executable ? "ready" : undefined}><span>Executable</span><strong>{executable}</strong><small>threshold and timelock satisfied</small></article>
        <article><span>Executed</span><strong>{executed}</strong><small>canonical actions completed</small></article>
      </section>

      {charterConfigured && canReviewFactories ? (
        <FactoryOnboardingConsole
          charterAddress={charterAddressRaw as Address}
          chainId={chainId}
          requests={factoryReviews}
        />
      ) : null}

      {charterConfigured && canUseGovernanceConsole ? (
        <GovernanceConsole
          charterAddress={charterAddressRaw as Address}
          chainId={chainId}
          organizations={targetOrganizations}
          proposalIds={rows.map((proposal) => proposal.chain_proposal_id)}
        />
      ) : charterConfigured ? (
        <section className="panel"><div className="empty-state"><strong>Read-only governance session</strong><span>Your current application memberships do not expose the governance transaction console. On-chain authority still depends on the wallet's active Registry organization and constituency.</span></div></section>
      ) : (
        <section className="panel"><div className="alert alert-error">ThreadProofCharter is not configured for this web deployment. Governance writes fail closed until THREADPROOF_CHARTER_ADDRESS and the ThreadProof chain id are configured.</div></section>
      )}

      <section className="card-grid">
        {rows.map((proposal) => {
          const state = projectedState(proposal);
          return <article className="entity-card governance-proposal-card" key={proposal.chain_proposal_id}>
            <div className="entity-card-top"><div><span className="kicker">{titleCase(proposal.proposal_type)}</span><h2>{shortHash(proposal.chain_proposal_id, 12, 8)}</h2></div><StatusBadge value={state} /></div>
            <dl className="definition-grid">
              <div><dt>Approvals</dt><dd>{proposal.approvals_received} / {proposal.approvals_required ?? "—"}</dd></div>
              <div><dt>Constituency mask</dt><dd>{proposal.approval_mask}</dd></div>
              <div><dt>Policy version</dt><dd>{proposal.policy_version ?? "—"}</dd></div>
              <div><dt>Action commitment</dt><dd className="mono">{proposal.action_hash ? shortHash(proposal.action_hash, 10, 8) : "—"}</dd></div>
              <div><dt>Expires</dt><dd>{formatDate(proposal.expires_at, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
              <div><dt>Execute after</dt><dd>{formatDate(proposal.execute_after, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
              <div><dt>Executed tx</dt><dd className="mono">{proposal.executed_tx_hash ? shortHash(proposal.executed_tx_hash) : "—"}</dd></div>
              <div><dt>Last synced block</dt><dd>{proposal.last_synced_block}</dd></div>
            </dl>
            <Link className="proposal-open-link" href={`/app/governance/${proposal.chain_proposal_id}`}>Open proposal evidence →</Link>
          </article>;
        })}
        {!rows.length ? <div className="empty-state large full-span"><strong>No governance proposals indexed</strong><span>Once ThreadProofCharter emits ProposalCreated, the indexer will materialize this rebuildable audit view. Proposal authority remains entirely on-chain.</span></div> : null}
      </section>
    </div>
  );
}
