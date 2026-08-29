import { redirect } from "next/navigation";
import { getViewer } from "@/lib/viewer";
import { acceptInvitationAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  if (!/^[0-9a-f]{48}$/i.test(token)) redirect("/onboarding?error=Invalid+invitation+link.");
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  return (
    <main className="simple-shell">
      <section className="narrow-card centered-card">
        <span className="kicker">ORGANIZATION INVITATION</span>
        <h1>Join a ThreadProof workspace</h1>
        <p className="muted">You are signed in as <strong>{viewer.email}</strong>. The invitation is accepted only if it was issued to this exact authenticated email and has not expired.</p>
        <form action={acceptInvitationAction}><input type="hidden" name="token" value={token} /><button className="button primary">Accept invitation</button></form>
        <p className="form-help">Accepting an invitation grants application membership. Protocol signing authority still depends on the organization’s on-chain account configuration.</p>
      </section>
    </main>
  );
}
