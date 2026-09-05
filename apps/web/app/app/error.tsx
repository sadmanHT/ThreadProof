"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RotateCcw, ShieldCheck } from "lucide-react";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("ThreadProof workspace render error", error);
  }, [error]);

  return (
    <div className="workspace-page recovery-page" role="alert">
      <section className="panel recovery-card">
        <span className="recovery-icon danger" aria-hidden="true"><AlertTriangle size={24} /></span>
        <span className="kicker">WORKSPACE RECOVERY</span>
        <h1>This workspace could not finish loading</h1>
        <p>The request failed before ThreadProof could present a complete view. Retrying is safe: a page-render failure does not authorize an order, consume confidential capacity, issue a credential, or execute Charter governance.</p>
        <div className="callout">
          <strong><ShieldCheck size={15} /> Canonical authority remains unchanged</strong>
          <span>Only accepted signatures, verified proofs and finalized consortium-chain transactions can change protocol state.</span>
        </div>
        <div className="recovery-actions">
          <button className="button primary" type="button" onClick={reset}><RotateCcw size={15} /> Try again</button>
          <Link className="button secondary" href="/app">Return to overview</Link>
        </div>
        {error.digest ? <small className="muted">Support reference: <span className="mono">{error.digest}</span></small> : null}
      </section>
    </div>
  );
}
