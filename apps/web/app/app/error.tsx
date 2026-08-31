"use client";

import { useEffect } from "react";

export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("ThreadProof workspace render error", error);
  }, [error]);

  return (
    <div className="workspace-page">
      <section className="workspace-error panel">
        <div className="error-mark" aria-hidden="true">!</div>
        <span className="kicker">WORKSPACE RECOVERY</span>
        <h1>This view could not be loaded.</h1>
        <p>ThreadProof did not change any protocol state. Retry the view, or return to the workspace overview if the upstream service remains unavailable.</p>
        {error.digest ? <code className="error-digest">Reference {error.digest}</code> : null}
        <div className="form-actions"><button className="button primary" type="button" onClick={reset}>Try again</button><a className="button secondary" href="/app">Return to overview</a></div>
      </section>
    </div>
  );
}
