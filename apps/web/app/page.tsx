import Link from "next/link";

const pillars = [
  ["Canonical private capacity", "Certified capacity becomes a state commitment that can be consumed once, not a number factories can rewrite per buyer."],
  ["Zero-knowledge feasibility", "Prove that an order fits inside the current capacity state without revealing remaining capacity, workload, or competing buyers."],
  ["Buyer-signed orders", "Material order versions are immutable and buyer-authorized, so later commercial changes cannot hide behind an older feasibility proof."],
  ["Governed accountability", "Credentials, subcontract paths and exceptional disclosure powers are attributable, revocable and controlled by consortium governance."],
] as const;

const metrics = [
  ["Private by default", "Commercial workloads and capacity openings stay confidential"],
  ["Chain-authoritative", "Critical state changes become canonical only on Besu"],
  ["Proof-bound", "Feasibility proofs bind to the exact current order and capacity state"],
  ["Governed", "Sensitive protocol powers require attributable consortium action"],
] as const;

export default function HomePage() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav">
        <Link className="brand-lockup" href="/">ThreadProof</Link>
        <div><a href="#protocol">Protocol</a><a href="#trust">Trust model</a><Link className="button small secondary" href="/login">Member sign in</Link></div>
      </nav>

      <section className="landing-hero">
        <div>
          <span className="kicker">PRIVACY-PRESERVING PRODUCTION AUTHORIZATION</span>
          <h1>Know an order is feasible.<br />Never expose the factory’s order book.</h1>
          <p>ThreadProof gives apparel buyers, factories, auditors and regulators a shared, cryptographically verifiable production-authorization layer—without turning commercially sensitive capacity and workload into shared data.</p>
          <div className="hero-actions"><Link className="button primary" href="/login">Open consortium workspace</Link><a className="button ghost" href="#protocol">Explore the protocol</a></div>
          <div className="hero-proofline"><span />Critical writes remain chain-gated. Application state is never treated as canonical.</div>
        </div>
        <div className="state-visual" aria-label="Canonical capacity transition">
          <div className="state-visual-head"><strong>Capacity transition</strong><span>Verified</span></div>
          <div className="state-node spent"><span>State C₅</span><small>spent</small></div>
          <div className="state-arrow"><span>PoFC proof</span>→</div>
          <div className="state-node active"><span>State C₆</span><small>canonical</small></div>
          <p>Two valid proofs may target C₅. <strong>Only one can advance the canonical state.</strong></p>
        </div>
      </section>

      <section className="hero-metrics" aria-label="ThreadProof trust properties">
        {metrics.map(([title, body]) => <div className="hero-metric" key={title}><strong>{title}</strong><span>{body}</span></div>)}
      </section>

      <section id="protocol" className="landing-section">
        <div className="section-heading wide"><span className="kicker">THE PROTOCOL</span><h2>Shared truth without shared commercial secrets.</h2><p>Blockchain and zero knowledge solve different parts of the problem. The chain serializes which hidden state is current; the proof demonstrates that a private transition is valid without revealing the witness behind it.</p></div>
        <div className="pillar-grid">{pillars.map(([title, body], index) => <article className="pillar-card" key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
      </section>

      <section id="trust" className="trust-section">
        <div><span className="kicker">TRUST BOUNDARY</span><h2>The application coordinates.<br />The chain decides.</h2><p className="muted">Every layer has a deliberately narrow responsibility. ThreadProof keeps workflow convenience separate from protocol authority.</p></div>
        <div className="trust-stack">
          <div><strong>Supabase + Next.js</strong><span>Identity, memberships, encrypted workflow data, proof jobs, audit records and permission-scoped read models.</span></div>
          <div><strong>ZK worker</strong><span>Constructs confidential witnesses, generates proofs and relays only authorization-bound protocol transactions.</span></div>
          <div className="canonical"><strong>Besu + contracts</strong><span>Canonical order versions, credential status, capacity state, nullifiers, subcontract authorization and governance execution.</span></div>
        </div>
      </section>

      <footer className="landing-footer"><strong>ThreadProof</strong><span>Prove the supply chain is feasible and compliant without revealing the supply chain.</span><Link href="/login">Consortium access →</Link></footer>
    </main>
  );
}
