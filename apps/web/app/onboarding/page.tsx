import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireViewer } from "@/lib/viewer";
import { formatDate, shortHash } from "@/lib/format";
import { OnboardingRequestForm } from "@/components/onboarding-request-form";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const viewer = await requireViewer();
  if (viewer.isConsortiumMember) redirect("/app");

  const supabase = await createClient();
  const { data: requests } = await supabase
    .from("organization_onboarding_requests")
    .select("id,display_name,status,created_at,primary_account,proposed_chain_organization_id,metadata_hash,action_hash,chain_proposal_id,chain_registration_tx_hash")
    .eq("requested_by", viewer.userId)
    .order("created_at", { ascending: false })
    .limit(5);
  const pending = (requests ?? []).find((request) => request.status === "pending");

  return (
    <main className="simple-shell">
      <div className="simple-topbar"><a className="brand-lockup" href="/">ThreadProof</a><form action="/auth/signout" method="post"><button className="text-button">Sign out</button></form></div>
      <section className="narrow-card">
        <span className="kicker">CANONICAL FACTORY ONBOARDING</span>
        <h1>Bind your application identity to a consortium factory.</h1>
        <p className="muted">An application account is not protocol authority. Factory onboarding becomes effective only when the proposed wallet proves control, the Charter receives both auditor and industry constituency approval, and ThreadProofRegistry emits the exact matching registration event.</p>

        {pending ? (
          <div className="pending-panel">
            <span className="badge warning">Pending on-chain governance</span>
            <h2>{pending.display_name}</h2>
            <p>Factory · submitted {formatDate(pending.created_at)}</p>
            <dl className="definition-grid">
              <div><dt>Primary wallet</dt><dd className="mono">{pending.primary_account ? shortHash(pending.primary_account, 10, 8) : "—"}</dd></div>
              <div><dt>Proposed organization</dt><dd className="mono">{pending.proposed_chain_organization_id ? shortHash(pending.proposed_chain_organization_id, 10, 8) : "—"}</dd></div>
              <div><dt>Action commitment</dt><dd className="mono">{pending.action_hash ? shortHash(pending.action_hash, 10, 8) : "—"}</dd></div>
              <div><dt>Charter proposal</dt><dd className="mono">{pending.chain_proposal_id ? shortHash(pending.chain_proposal_id, 10, 8) : "Not opened yet"}</dd></div>
            </dl>
            <p className="muted">No database operator can approve this request. After the exact OrganizationRegistered event is indexed, your initial admin membership is materialized and this account enters the consortium workspace.</p>
          </div>
        ) : (
          <OnboardingRequestForm />
        )}
      </section>
    </main>
  );
}
