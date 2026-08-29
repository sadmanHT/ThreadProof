const capabilities = [
  ["Confidential capacity", "Prove order feasibility without exposing exact capacity or competing orders."],
  ["Non-reusable state", "Consume the active capacity commitment once and reject stale or replayed spends."],
  ["Authorized subcontracting", "Require parent-order lineage, valid credentials, policy depth, and capacity authorization."],
  ["Shared governance", "Execute sensitive actions only after role-diverse Charter approvals."],
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">ENDGAME · THREADPROOF</div>
        <h1>Confidential capacity governance for responsible apparel supply chains.</h1>
        <p className="lede">
          ThreadProof is a permissioned blockchain network that lets apparel organizations prove production feasibility,
          compliance, and authorization without publishing the commercial data used to satisfy those rules.
        </p>
        <div className="status-row">
          <span className="status-dot" aria-hidden="true" />
          <span>Product foundation in active development</span>
        </div>
      </section>

      <section className="capability-grid" aria-label="ThreadProof capabilities">
        {capabilities.map(([title, body]) => (
          <article className="capability-card" key={title}>
            <h2>{title}</h2>
            <p>{body}</p>
          </article>
        ))}
      </section>

      <section className="principle">
        <span>Design principle</span>
        <strong>Prove the supply chain is feasible and compliant without revealing the supply chain.</strong>
      </section>
    </main>
  );
}
