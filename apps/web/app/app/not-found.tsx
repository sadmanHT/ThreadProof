import Link from "next/link";
import { FileQuestion, ShieldCheck } from "lucide-react";

export default function WorkspaceNotFound() {
  return (
    <div className="workspace-page recovery-page">
      <section className="panel recovery-card">
        <span className="recovery-icon" aria-hidden="true"><FileQuestion size={24} /></span>
        <span className="kicker">WORKSPACE RECORD</span>
        <h1>This record is not available in your active context</h1>
        <p>It may have been removed, the link may be outdated, or your active organization may not be allowed to read it. ThreadProof intentionally treats unauthorized and unavailable scoped records the same way.</p>
        <div className="callout">
          <strong><ShieldCheck size={15} /> Privacy-preserving failure</strong>
          <span>No hidden organization, order, capacity, credential, or investigation data is revealed by this response.</span>
        </div>
        <div className="recovery-actions">
          <Link className="button primary" href="/app">Return to overview</Link>
          <Link className="button secondary" href="/app/orders">Open orders</Link>
        </div>
      </section>
    </div>
  );
}
