import Link from "next/link";

export default function NotFound() {
  return <main className="simple-shell"><section className="narrow-card centered-card"><span className="kicker">404</span><h1>That ThreadProof record is not available.</h1><p className="muted">It may not exist, or your organization may not be authorized to view it.</p><Link className="button primary" href="/app">Back to workspace</Link></section></main>;
}
