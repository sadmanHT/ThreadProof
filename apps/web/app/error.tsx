"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ThreadProof route rendering failed", { digest: error.digest ?? "unavailable" });
  }, [error.digest]);

  return (
    <main className="runtime-state-page">
      <section className="runtime-state-card" role="alert">
        <span className="runtime-state-icon" aria-hidden="true"><AlertTriangle size={22} /></span>
        <h1>This workspace could not be loaded.</h1>
        <p>
          ThreadProof stopped this view instead of continuing with incomplete runtime state. Retry the request, or return to the workspace and choose another operation.
        </p>
        <div className="runtime-state-actions">
          <button className="runtime-state-button" type="button" onClick={reset}>
            <RefreshCw size={15} /> Retry safely
          </button>
          <Link className="runtime-state-button secondary" href="/app">Return to workspace</Link>
        </div>
        {error.digest ? <div className="runtime-state-digest">Reference: {error.digest}</div> : null}
      </section>
    </main>
  );
}
