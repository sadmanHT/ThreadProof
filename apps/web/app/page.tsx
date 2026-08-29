import Link from "next/link";

const pillars = [
  ["Canonical private capacity", "Certified capacity becomes a state commitment that can be consumed once, not a number factories can rewrite per buyer."],
  ["Zero-knowledge feasibility", "Prove that an order fits inside the current capacity state without revealing remaining capacity, workload, or competing buyers."],
  ["Buyer-signed orders", "Material order versions are immutable and buyer-authorized, so later commercial changes cannot hide behind an older feasibility proof."],
  ["Governed accountability", "Credentials, subcontract paths and exceptional disclosure powers are attributable, revocable and controlled by consortium governance."],
] as const;

export default function HomePage() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav"><Link className="brand-lockup" href="/">ThreadProof</Link><div><a href="#protocol">Protocol</a><a href="#trust">Trust model</a><Link className="button small secondary" href="/login">Member sign in</Link></div></nav>
      <section className="landing-hero"><div><span className="kicker">PRIVACY-PRESERVING PRODUCTION AUTHORIZATION</span><h1>Know an order is feasible.<br />Never expose the factory’s order book.</h1><p>ThreadProof lets apparel buyers, factories, auditors and regulators share one canonical view of production authorization while keeping commercially sensitive capacity and workload private.</p><div className="hero-actions"><Link className="button primary" href="/login">Open consortium workspace</Link><a className="button ghost" href="#protocol">See how it works</a></div></div><div className="state-visual" aria-label="Canonical capacity transition"><div className="state-node spent"><span>State C₅</span><small>spent</small></div><div className="state-arrow"><span>PoFC</span>→</div><div className="state-node active"><span>State C₆</span><small>canonical</small></div><p>Two valid proofs may target C₅.<br /><strong>Only one can advance it.</strong></p></div></section>
      <section id="protocol" className="landing-section"><div className="section-heading wide"><span className="kicker">THE PROTOCOL</span><h2>Shared truth without shared commercial secrets.</h2><p>Blockchain and zero knowledge solve different parts of the problem: the chain serializes which hidden state is current; the proof shows the hidden transition is valid.</p></div><div className="pillar-grid">{pillars.map(([title, body], index) => <article className="pillar-card" key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</div></section>
      <section id="trust" className="trust-section"><div><span className="kicker">TRUST BOUNDARY</span><h2>The application coordinates.<br />The chain decides.</h2></div><div className="trust-stack"><div><strong>Supabase + Next.js</strong><span>Auth, memberships, encrypted workflow data, proof jobs and read models</span></div><div><strong>ZK worker</strong><span>Constructs confidential witnesses and proves the capacity transition</span></div><div className="canonical"><strong>Besu + ThreadProof contracts</strong><span>Canonical orders, credential status, capacity state, nullifiers and governance execution</span></div></div></section>
      <footer className="landing-footer"><strong>ThreadProof</strong><span>Prove the supply chain is feasible and compliant without revealing the supply chain.</span><Link href="/login">Consortium access →</Link></footer>
    </main>
  );
}
