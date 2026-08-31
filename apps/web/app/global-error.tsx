"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ThreadProof root rendering failed", { digest: error.digest ?? "unavailable" });
  }, [error.digest]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", background: "#f5f7fa", color: "#172033" }}>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, boxSizing: "border-box" }}>
          <section style={{ width: "min(620px, 100%)", padding: 40, boxSizing: "border-box", border: "1px solid #e3e7ec", borderRadius: 24, background: "white", boxShadow: "0 28px 80px rgba(15,23,42,.09)" }}>
            <div style={{ width: 46, height: 46, display: "grid", placeItems: "center", borderRadius: 14, background: "#f4f8ff", color: "#285fb8", fontWeight: 800 }}>TP</div>
            <h1 style={{ margin: "22px 0 10px", fontSize: "clamp(2rem, 6vw, 3.3rem)", lineHeight: 1, letterSpacing: "-.05em" }}>ThreadProof stopped safely.</h1>
            <p style={{ margin: 0, color: "#667085", lineHeight: 1.65 }}>
              The application shell encountered an unexpected runtime failure. No operation should be assumed complete from this screen.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 28 }}>
              <button type="button" onClick={reset} style={{ minHeight: 42, padding: "9px 14px", border: "1px solid #1d2939", borderRadius: 10, background: "#1d2939", color: "white", font: "inherit", fontWeight: 700, cursor: "pointer" }}>Retry</button>
              <a href="/" style={{ minHeight: 42, padding: "9px 14px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", border: "1px solid #d9dee6", borderRadius: 10, color: "#344054", textDecoration: "none", fontWeight: 700 }}>Return home</a>
            </div>
            {error.digest ? <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid #edf0f3", color: "#98a2b3", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>Reference: {error.digest}</div> : null}
          </section>
        </main>
      </body>
    </html>
  );
}
