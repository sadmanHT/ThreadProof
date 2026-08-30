import Link from "next/link";
import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

const nav = [
  ["/app", "Overview"],
  ["/app/orders", "Orders"],
  ["/app/intelligence", "Intelligence"],
  ["/app/credentials", "Credentials"],
  ["/app/capacity", "Capacity"],
  ["/app/proofs", "Proofs"],
  ["/app/governance", "Governance"],
  ["/app/chain", "Chain activity"],
  ["/app/team", "Team"],
  ["/app/settings", "Settings"],
] as const;

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireConsortiumViewer();
  const primary = viewer.memberships[0];
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link href="/app" className="sidebar-brand"><span className="brand-mark">TP</span><span><strong>ThreadProof</strong><small>Consortium workspace</small></span></Link>
        <nav className="sidebar-nav" aria-label="Product navigation">
          {nav.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
        <div className="sidebar-footer">
          {primary ? <div className="org-chip"><span>{primary.organization.display_name}</span><small>{titleCase(primary.organization.role)} · {titleCase(primary.member_role)}</small></div> : null}
          <div className="user-chip"><span>{viewer.profile?.display_name || viewer.email}</span><small>{viewer.email}</small></div>
          <form action="/auth/signout" method="post"><button className="text-button">Sign out</button></form>
        </div>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  );
}
