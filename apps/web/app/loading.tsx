export default function Loading() {
  return (
    <main className="runtime-state-page" aria-busy="true" aria-label="Loading ThreadProof workspace">
      <div className="runtime-loading-shell">
        <div className="runtime-skeleton hero" />
        <div className="runtime-skeleton row" />
        <div className="runtime-skeleton row" />
        <div className="runtime-skeleton row" />
      </div>
    </main>
  );
}
