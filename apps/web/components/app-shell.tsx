"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type IconName = "overview" | "orders" | "intelligence" | "credentials" | "capacity" | "proofs" | "governance" | "chain" | "team" | "settings" | "menu" | "close" | "arrow" | "shield";

const nav = [
  ["/app", "Overview", "overview"],
  ["/app/orders", "Orders", "orders"],
  ["/app/intelligence", "Intelligence", "intelligence"],
  ["/app/credentials", "Credentials", "credentials"],
  ["/app/capacity", "Capacity", "capacity"],
  ["/app/proofs", "Proofs", "proofs"],
  ["/app/governance", "Governance", "governance"],
  ["/app/chain", "Chain activity", "chain"],
  ["/app/team", "Team", "team"],
  ["/app/settings", "Settings", "settings"],
] as const satisfies readonly (readonly [string, string, IconName])[];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "overview": return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>;
    case "orders": return <svg {...common}><path d="M7 3h10l3 3v15H4V6l3-3Z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>;
    case "intelligence": return <svg {...common}><path d="M12 3a6 6 0 0 0-3.7 10.7c.8.6 1.2 1.4 1.2 2.3h5c0-.9.4-1.7 1.2-2.3A6 6 0 0 0 12 3Z"/><path d="M9.5 20h5M9.5 17h5M12 1v1M4.2 5.2l1.4 1.4M19.8 5.2l-1.4 1.4"/></svg>;
    case "credentials": return <svg {...common}><path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6"/><path d="m9 16 2 2 4-4"/></svg>;
    case "capacity": return <svg {...common}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="m3 7 6-4 6 6 6-5"/></svg>;
    case "proofs": return <svg {...common}><path d="M12 2 4.5 5v6c0 5 3.2 8.8 7.5 11 4.3-2.2 7.5-6 7.5-11V5L12 2Z"/><path d="m8.5 12 2.3 2.3 4.7-5"/></svg>;
    case "governance": return <svg {...common}><path d="M3 10h18M5 10V8l7-4 7 4v2M5 20h14M7 10v7M12 10v7M17 10v7"/></svg>;
    case "chain": return <svg {...common}><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>;
    case "team": return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>;
    case "menu": return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
    case "close": return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
    case "arrow": return <svg {...common}><path d="M5 12h14M14 7l5 5-5 5"/></svg>;
    case "shield": return <svg {...common}><path d="M12 2 4.5 5v6c0 5 3.2 8.8 7.5 11 4.3-2.2 7.5-6 7.5-11V5L12 2Z"/><path d="M9.5 12.2 11 13.7l3.6-3.8"/></svg>;
  }
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TP";
}

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === "/app" : pathname === href || pathname.startsWith(`${href}/`);
}

function pageName(pathname: string) {
  const match = nav.find(([href]) => isActive(pathname, href));
  return match?.[1] ?? "Workspace";
}

type Props = {
  children: ReactNode;
  organizationName?: string;
  organizationRole?: string;
  memberRole?: string;
  userName: string;
  email: string;
};

export function AppShell({ children, organizationName, organizationRole, memberRole, userName, email }: Props) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPage = useMemo(() => pageName(pathname), [pathname]);
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <div className="app-frame">
      <button className={`sidebar-backdrop ${mobileOpen ? "visible" : ""}`} aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <Link href="/app" className="sidebar-brand">
            <span className="brand-mark"><Icon name="shield" size={19} /></span>
            <span><strong>ThreadProof</strong><small>Consortium protocol</small></span>
          </Link>
          <button className="sidebar-close" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="close" /></button>
        </div>

        <div className="sidebar-section-label">Workspace</div>
        <nav className="sidebar-nav" aria-label="Product navigation">
          {nav.slice(0, 8).map(([href, label, icon]) => {
            const active = isActive(pathname, href);
            return <Link key={href} href={href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}><span className="nav-icon"><Icon name={icon} /></span><span>{label}</span>{active ? <span className="nav-active-dot" /> : null}</Link>;
          })}
        </nav>

        <div className="sidebar-section-label sidebar-secondary-label">Organization</div>
        <nav className="sidebar-nav" aria-label="Organization navigation">
          {nav.slice(8).map(([href, label, icon]) => {
            const active = isActive(pathname, href);
            return <Link key={href} href={href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}><span className="nav-icon"><Icon name={icon} /></span><span>{label}</span>{active ? <span className="nav-active-dot" /> : null}</Link>;
          })}
        </nav>

        <div className="sidebar-footer">
          {organizationName ? <div className="org-card"><span className="avatar org-avatar">{initials(organizationName)}</span><div><strong>{organizationName}</strong><small>{[organizationRole, memberRole].filter(Boolean).join(" · ")}</small></div></div> : null}
          <div className="user-card"><span className="avatar">{initials(userName || email)}</span><div><strong>{userName || email}</strong><small>{email}</small></div></div>
          <form action="/auth/signout" method="post"><button className="sidebar-signout" type="submit"><span>Sign out</span><Icon name="arrow" size={15} /></button></form>
        </div>
      </aside>

      <div className="app-content">
        <header className="mobile-appbar">
          <button className="mobile-menu" type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
          <div><small>ThreadProof</small><strong>{currentPage}</strong></div>
          <span className="avatar compact-avatar">{initials(userName || email)}</span>
        </header>
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}
