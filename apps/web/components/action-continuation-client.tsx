"use client";

import { useEffect } from "react";

export function ActionContinuationClient({ target }: { target: string }) {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  return (
    <main className="public-shell" aria-live="polite">
      <section className="public-card">
        <p className="eyebrow">ThreadProof</p>
        <h1>Finishing your request…</h1>
        <p className="muted">Applying the latest workspace state.</p>
        <noscript>
          <a href={target}>Continue</a>
        </noscript>
      </section>
    </main>
  );
}
