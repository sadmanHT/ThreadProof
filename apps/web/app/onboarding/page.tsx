import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireViewer } from "@/lib/viewer";
import { formatDate, titleCase } from "@/lib/format";
import { submitOnboardingRequest } from "./actions";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OnboardingPage({ searchParams }: Props) {
  const viewer = await requireViewer();
  if (viewer.isConsortiumMember) redirect("/app");
  const supabase = await createClient();
  const { data: requests } = await supabase
    .from("organization_onboarding_requests")
    .select("*")
    .eq("requested_by", viewer.userId)
    .order("created_at", { ascending: false })
    .limit(5);
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  const pending = (requests ?? []).find((request) => request.status === "pending");

  return (
    <main className="simple-shell">
      <div className="simple-topbar"><a className="brand-lockup" href="/">ThreadProof</a><form action="/auth/signout" method="post"><button className="text-button">Sign out</button></form></div>
      <section className="narrow-card">
        <span className="kicker">ORGANIZATION ONBOARDING</span>
        <h1>Connect your identity to a consortium organization.</h1>
        <p className="muted">An application account is not enough to exercise protocol authority. Membership is activated only after the organization is recognized by the consortium and linked to its on-chain identity.</p>
        {message ? <div className="alert alert-success">{message}</div> : null}
        {error ? <div className="alert alert-error">{error}</div> : null}

        {pending ? (
          <div className="pending-panel"><span className="badge warning">Pending review</span><h2>{pending.display_name}</h2><p>{titleCase(pending.requested_role)} · submitted {formatDate(pending.created_at)}</p><p className="muted">You can also join an existing organization immediately if an admin sends you an invitation link.</p></div>
        ) : (
          <form className="stack-form" action={submitOnboardingRequest}>
            <div className="field-grid two"><label>Legal name<input name="legalName" required minLength={2} /></label><label>Display name<input name="displayName" required minLength={2} /></label></div>
            <div className="field-grid two"><label>Organization role<select name="role" defaultValue="factory"><option value="buyer">Buyer</option><option value="factory">Factory</option><option value="auditor">Auditor</option><option value="regulator">Regulator</option><option value="industry">Industry body</option><option value="labor_representative">Labor representative</option><option value="independent">Independent</option></select></label><label>Country code<input name="countryCode" maxLength={2} placeholder="BD" /></label></div>
            <label>Context for reviewers<textarea name="notes" rows={4} placeholder="Describe your organization and why it should join the ThreadProof consortium." /></label>
            <button className="button primary">Submit onboarding request</button>
          </form>
        )}
      </section>
    </main>
  );
}
