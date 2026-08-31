import Link from "next/link";
import { safeLocalPath } from "@/lib/safe-local-path";
import { loginAction, signupAction } from "./actions";

export const dynamic = "force-dynamic";
type LoginPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const trustPoints = [
  ["Permission scoped", "Supabase RLS limits application data to your consortium memberships."],
  ["Wallet separated", "Signing authority remains bound to the organization accounts registered on-chain."],
  ["Chain authoritative", "The application cannot declare capacity, credentials, orders or governance actions canonical."],
] as const;

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const message = typeof params.message === "string" ? params.message : null;
  const next = safeLocalPath(typeof params.next === "string" ? params.next : undefined);
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Link className="brand-lockup" href="/">ThreadProof</Link>
        <div className="auth-story-main">
          <span className="kicker">CONSORTIUM ACCESS</span>
          <h1>Private commercial data. Shared cryptographic certainty.</h1>
          <p>Permissions are enforced by Supabase RLS; production authorization remains anchored to the consortium chain.</p>
          <div className="auth-trust-list">{trustPoints.map(([title, body]) => <div key={title}><span /><div><strong>{title}</strong><small>{body}</small></div></div>)}</div>
        </div>
        <div className="trust-note"><strong>Trust boundary</strong><span>The application coordinates workflows. It cannot declare capacity, credentials, or governance actions canonical.</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-mark">TP</div>
          <div className="section-heading"><span>Member portal</span><h2>Sign in to ThreadProof</h2></div>
          {error ? <div className="alert alert-error">{error}</div> : null}{message ? <div className="alert alert-success">{message}</div> : null}
          <form className="stack-form"><input type="hidden" name="next" value={next} /><label>Display name <span className="optional">for new accounts</span><input name="displayName" autoComplete="name" placeholder="Your name" /></label><label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@organization.com" /></label><label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required placeholder="At least 8 characters" /></label><div className="form-actions split-actions"><button className="button primary" formAction={loginAction}>Sign in</button><button className="button secondary" formAction={signupAction}>Create account</button></div></form>
          <p className="form-help auth-help">New accounts must join an existing consortium organization by invitation or submit an onboarding request.</p>
        </div>
      </section>
    </main>
  );
}
