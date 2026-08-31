import Link from "next/link";
import { MarketingFooter, MarketingNav, PrivacyLabel, Reveal } from "@/components/marketing/premium-marketing";

const buyerNeeds = [
  "Can this order actually be produced?",
  "Is the factory authorized for this order?",
  "Are required credentials active now?",
  "Is every subcontract relationship legitimate?",
] as const;

const factorySecrets = [
  "Total and remaining production capacity",
  "Competing buyer orders and customer portfolio",
  "Complete production schedule and allocations",
  "Commercial terms and confidential relationships",
] as const;

const credentials = [
  { title: "Capacity Credential", scope: "Sewing · Q4 2026", issuer: "Independent auditor", status: "Active" },
  { title: "Factory Compliance", scope: "Facility-wide", issuer: "Accredited assessor", status: "Active" },
  { title: "Process Authorization", scope: "Finishing · Dyeing", issuer: "Consortium issuer", status: "Active" },
] as const;

export default function HomePage() {
  return (
    <main className="premium-page">
      <MarketingNav />

      <section className="premium-hero">
        <div className="premium-mesh" />
        <div className="premium-hero-inner">
          <Reveal>
            <span className="premium-eyebrow">Privacy-preserving consortium infrastructure</span>
            <h1 className="premium-display">Prove capacity.<br /><span className="soft">Protect confidentiality.</span></h1>
            <p className="premium-lede">ThreadProof lets apparel supply-chain participants verify that production commitments are feasible, authorized and compliant—without exposing sensitive factory capacity, competing orders or commercial relationships.</p>
            <div className="premium-actions"><a className="button premium-cta blue" href="#how-it-works">Explore ThreadProof</a><Link className="premium-secondary-link" href="/console">Open Console</Link></div>
            <div className="hero-trust-line">The application coordinates. Canonical authorization remains on the consortium protocol.</div>
          </Reveal>

          <Reveal delay={120}>
            <div className="thread-diagram" aria-label="Buyer to factory production authorization diagram">
              <div className="diagram-toolbar"><span>Authorization thread · TP-24031</span><span className="diagram-status">verified path</span></div>
              <div className="diagram-canvas">
                <div className="diagram-private"><b>private</b> capacity opening</div>
                <div className="diagram-path" />
                <div className="diagram-drop" />
                <div className="diagram-node buyer"><strong>Buyer</strong><span>signed order</span></div>
                <div className="diagram-node proof"><strong>Capacity proof</strong><span>condition verified</span></div>
                <div className="diagram-node factory"><strong>Factory Alpha</strong><span>authorized producer</span></div>
                <div className="diagram-node production"><strong>Production authorized</strong><span>without capacity disclosure</span></div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section id="how-it-works" className="premium-section soft">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">The central tension</span><h2>Buyers need assurance.<br />Factories need confidentiality.</h2><p>ThreadProof is designed around the fact that both requirements are legitimate. Verification should not require surveillance.</p></div></Reveal>
          <div className="tension-grid">
            <Reveal><article className="tension-pane"><span>Buyer needs to know</span><h3>Can I responsibly authorize this order?</h3><div className="tension-list">{buyerNeeds.map((item) => <div key={item}><span>{item}</span><i /></div>)}</div></article></Reveal>
            <Reveal delay={100}><article className="tension-pane private"><span>Factory should not reveal</span><h3>Commercial information that belongs to the factory.</h3><div className="tension-list">{factorySecrets.map((item) => <div key={item}><span>{item}</span><i /></div>)}</div></article></Reveal>
          </div>
          <Reveal><div className="story-convergence"><span className="premium-kicker">ThreadProof</span><h2>Verify the condition — not the confidential data.</h2><p>Cryptographic commitments, zero-knowledge proofs and canonical state transitions create a shared answer without creating a shared private dataset.</p></div></Reveal>
        </div>
      </section>

      <section className="premium-section">
        <div className="premium-section-inner">
          <div className="proof-stage">
            <Reveal className="proof-copy"><span className="premium-kicker">Proof-of-Feasible-Capacity</span><h3>Capacity that can be verified, not exposed.</h3><p>An auditor certifies a private capacity state. When an order consumes capacity, the factory proves that the transition is valid without revealing the opening, remaining capacity or competing workload.</p><div className="premium-actions"><Link className="premium-secondary-link" href="/protocol">See the protocol model</Link></div></Reveal>
            <Reveal delay={100}><div className="proof-visual"><div className="proof-flow">
              <div className="proof-step"><span className="index">01</span><div><strong>Certified capacity state</strong><small>Active commitment C₅</small></div><span className="masked-value">••••••••</span></div><div className="proof-arrow" />
              <div className="proof-step"><span className="index">02</span><div><strong>Order workload</strong><small>Quantity × production standard</small></div><span className="masked-value">private</span></div><div className="proof-arrow" />
              <div className="proof-step verified"><span className="index">03</span><div><strong>Zero-knowledge proof</strong><small>Feasibility condition verified</small></div><span className="status-dot">Valid</span></div><div className="proof-arrow" />
              <div className="proof-step verified"><span className="index">04</span><div><strong>New capacity state</strong><small>C₅ spent · C₆ active</small></div><span className="masked-value">••••••••</span></div>
            </div></div></Reveal>
          </div>
        </div>
      </section>

      <section className="premium-section dark">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">Canonical state</span><h2>One capacity state.<br />One valid transition.</h2><p>Two mathematically valid proofs can target the same previous state. The consortium chain serializes which transition is current and rejects reuse of the consumed state.</p></div></Reveal>
          <div className="double-spend">
            <Reveal><div className="state-origin"><strong>Capacity state C₀</strong><br /><small>active commitment</small></div></Reveal>
            <div className="state-branches">
              <Reveal><article className="state-branch accepted"><small>Order A · first finalized transition</small><h3>Accepted → C₁</h3><p>Proof valid. C₀ was current at execution.</p><div className="state-result"><span>Capacity state reuse</span><b>Prevented by state transition</b></div></article></Reveal>
              <Reveal delay={100}><article className="state-branch rejected"><small>Order B · competing transition</small><h3>Rejected</h3><p>The proof may still be mathematically valid, but C₀ is no longer the active state.</p><div className="state-result"><span>Reason</span><b>State already consumed</b></div></article></Reveal>
            </div>
          </div>
        </div>
      </section>

      <section className="premium-section soft">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">Chain of Authorization</span><h2>Subcontracting becomes an attributable production path.</h2><p>ThreadProof does not pretend subcontracting can simply be eliminated. It makes authorized production relationships explicit, credential-aware and bound to the parent order.</p></div></Reveal>
          <div className="auth-chain">
            <Reveal><article className="org-node"><div className="org-orb">B</div><h3>Buyer North</h3><p>Parent order owner</p><div className="org-checks"><span>Order signed</span></div></article></Reveal>
            <Reveal delay={90}><article className="org-node"><div className="org-orb">A</div><h3>Factory Alpha</h3><p>Primary authorized factory</p><div className="org-checks"><span>Credentials active</span><span>Depth 0</span></div></article></Reveal>
            <Reveal delay={180}><article className="org-node"><div className="org-orb">B</div><h3>Factory Beta</h3><p>Authorized subcontractor</p><div className="org-checks"><span>Parent valid</span><span>Capacity verified</span><span>Depth 1</span></div></article></Reveal>
          </div>
        </div>
      </section>

      <section className="premium-section">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">Verifiable credentials</span><h2>External claims stay attributable to the institution that made them.</h2><p>Credentials behave like enterprise verification objects—not collectible tokens. Their issuer, subject, scope, validity and revocation state remain explicit.</p></div></Reveal>
          <div className="credential-grid">{credentials.map((credential, index) => <Reveal key={credential.title} delay={index * 70}><article className="credential-object"><div className="credential-head"><PrivacyLabel tone="consortium">Consortium-visible status</PrivacyLabel><span className="status-dot">{credential.status}</span></div><h3>{credential.title}</h3><p>Verification metadata is visible where policy permits; underlying assessment material remains outside the public chain state.</p><div className="credential-meta"><div><small>Issuer</small><strong>{credential.issuer}</strong></div><div><small>Scope</small><strong>{credential.scope}</strong></div></div></article></Reveal>)}</div>
        </div>
      </section>

      <section className="premium-section soft">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">Privacy architecture</span><h2>Not everything belongs on-chain.</h2><p>ThreadProof separates shared protocol facts from counterparty data, zero-knowledge witness state and governance-protected information.</p></div></Reveal>
          <div className="privacy-layers">
            <Reveal><div className="privacy-orbit" aria-label="ThreadProof privacy layers"><div className="privacy-ring r1">Consortium-visible</div><div className="privacy-ring r2">Counterparty-confidential</div><div className="privacy-ring r3">Zero-knowledge private</div><div className="privacy-core">Governance<br/>protected</div></div></Reveal>
            <div className="privacy-copy-list">
              <Reveal><article><PrivacyLabel tone="consortium">Consortium-visible</PrivacyLabel><h3>Commitments, policy references and credential status</h3><p>Shared facts required to coordinate the protocol without exposing underlying commercial values.</p></article></Reveal>
              <Reveal delay={50}><article><PrivacyLabel tone="shared">Counterparty-confidential</PrivacyLabel><h3>Purchase orders and commercial terms</h3><p>Available only to organizations with a legitimate workflow relationship.</p></article></Reveal>
              <Reveal delay={100}><article><PrivacyLabel tone="private">Zero-knowledge private</PrivacyLabel><h3>Exact capacity, remaining capacity and private workload values</h3><p>Used to produce cryptographic evidence; not surfaced to unauthorized counterparties.</p></article></Reveal>
              <Reveal delay={150}><article><PrivacyLabel tone="protected">Governance protected</PrivacyLabel><h3>Sensitive identities and investigation material</h3><p>Protected until due-process governance authorizes disclosure under the Charter.</p></article></Reveal>
            </div>
          </div>
          <Reveal><div className="premium-actions"><Link className="premium-secondary-link" href="/privacy">Explore the privacy model</Link></div></Reveal>
        </div>
      </section>

      <section id="governance" className="premium-section dark">
        <div className="premium-section-inner">
          <Reveal><div className="premium-section-heading"><span className="premium-kicker">ThreadProof Charter</span><h2>Institutional governance, not retail DAO voting.</h2><p>Exceptional powers require independent constituencies, explicit thresholds and timelocks. Validators order transactions; governance decides who may exercise exceptional authority.</p></div></Reveal>
          <Reveal><div className="governance-panel"><div className="governance-summary"><PrivacyLabel tone="protected">Governance protected</PrivacyLabel><h3>Protected identity disclosure</h3><p>Investigation TP-GOV-042 · parameters are committed before voting and cannot be substituted at execution.</p><div className="threshold"><strong>3 / 5</strong><span>threshold reached</span></div></div><div className="approval-list">
            <div className="approval-row"><div><strong>Buyer representative</strong><small>Independent constituency</small></div><span className="approval-state approved">✓ Approved</span></div>
            <div className="approval-row"><div><strong>Independent auditor</strong><small>Independent constituency</small></div><span className="approval-state approved">✓ Approved</span></div>
            <div className="approval-row"><div><strong>Regulatory representative</strong><small>Independent constituency</small></div><span className="approval-state approved">✓ Approved</span></div>
            <div className="approval-row"><div><strong>Industry representative</strong><small>Independent constituency</small></div><span className="approval-state">Pending</span></div>
            <div className="approval-row"><div><strong>Labor standards representative</strong><small>Independent constituency</small></div><span className="approval-state">Pending</span></div>
          </div></div></Reveal>
          <Reveal><div className="premium-actions"><Link className="button premium-cta blue" href="/demo">Run the demo scenario</Link><Link className="premium-secondary-link" href="/architecture">View architecture</Link></div></Reveal>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
}
