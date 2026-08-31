export default function WorkspaceLoading() {
  return (
    <div className="workspace-page loading-page" aria-busy="true" aria-label="Loading workspace">
      <div className="loading-header"><div><span className="skeleton skeleton-kicker" /><span className="skeleton skeleton-title" /><span className="skeleton skeleton-copy" /></div><span className="skeleton skeleton-pill" /></div>
      <div className="loading-stats">{Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-stat" key={index} />)}</div>
      <div className="loading-panels"><div className="skeleton skeleton-panel" /><div className="skeleton skeleton-panel" /></div>
      <div className="skeleton skeleton-wide-panel" />
    </div>
  );
}
