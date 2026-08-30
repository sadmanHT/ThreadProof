import Link from "next/link";
import { safeLocalPath } from "@/lib/safe-local-path";
import { loginAction, signupAction } from "./actions";

export const dynamic = "force-dynamic";
type LoginPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const message = typeof params.message === "string" ? params.message : null;
  const next = safeLocalPath(typeof params.next === "string" ? params.next : undefined);
  return <main className="auth-shell"><section className="auth-story"><Link className="brand-lockup" href="/">ThreadProof</Link><div><span className="kicker">CONSORTIUM ACCESS</span><h1>Private commercial data. Shared cryptographic certainty.</h1><p>Sign in to your organization workspace. Permissions are enforced by Supabase RLS; production authorization remains anchored to the consortium chain.</p></div><div className="trust-note"><strong>Trust boundary</strong><span>The application coordinates workflows. It cannot declare capacity, credentials, or governance actions canonical.</span></div></section><section className="auth-panel"><div className="auth-card"><div className="section-heading"><span>Member portal</span><h2>Sign in to ThreadProof</h2></div>{error ? <div className="alert alert-error">{error}</div> : null}{message ? <div className="alert alert-success">{message}</div> : null}<form className="stack-form"><input type="hidden" name="next" value={next} /><label>Display name <span className="optional">(for new accounts)</span><input name="displayName" autoComplete="name" /></label><label>Email<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required /></label><div className="form-actions split-actions"><button className="button primary" formAction={loginAction}>Sign in</button><button className="button secondary" formAction={signupAction}>Create account</button></div></form><p className="form-help">New accounts must join an existing consortium organization by invitation or submit an onboarding request.</p></div></section></main>;
}
