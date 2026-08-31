"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import {
  ArrowRight,
  BadgeCheck,
  BrainCircuit,
  Building2,
  Command,
  FileText,
  Gauge,
  GitBranch,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

type IconName =
  | "overview"
  | "orders"
  | "intelligence"
  | "credentials"
  | "capacity"
  | "proofs"
  | "governance"
  | "chain"
  | "team"
  | "settings"
  | "subcontracts"
  | "audit";

type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: IconName;
  section: "workspace" | "organization";
  roles?: readonly string[];
};

const iconMap: Record<IconName, LucideIcon> = {
  overview: LayoutDashboard,
  orders: FileText,
  intelligence: BrainCircuit,
  credentials: BadgeCheck,
  capacity: Gauge,
  proofs: ShieldCheck,
  governance: Landmark,
  chain: Network,
  team: Users,
  settings: Settings,
  subcontracts: GitBranch,
  audit: SlidersHorizontal,
};

const governanceRoles = ["buyer", "factory", "auditor", "regulator", "industry", "labor_representative", "independent"] as const;

const nav: readonly NavItem[] = [
  { href: "/app", label: "Overview", description: "Role-aware operational summary", icon: "overview", section: "workspace" },
  { href: "/app/orders", label: "Orders", description: "Private commercial workflow and canonical versions", icon: "orders", section: "workspace", roles: ["buyer", "factory"] },
  { href: "/app/capacity", label: "Capacity", description: "Certified private capacity commitments", icon: "capacity", section: "workspace", roles: ["factory", "auditor"] },
  { href: "/app/proofs", label: "Proofs", description: "Proof-of-Feasible-Capacity execution", icon: "proofs", section: "workspace", roles: ["buyer", "factory", "auditor"] },
  { href: "/app/credentials", label: "Credentials", description: "Consortium authorization evidence", icon: "credentials", section: "workspace" },
  { href: "/app/subcontracts", label: "Subcontracts", description: "Authorized parent-child production paths", icon: "subcontracts", section: "workspace", roles: ["buyer", "factory"] },
  { href: "/app/organizations", label: "Organizations", description: "Consortium identity directory", icon: "team", section: "workspace" },
  { href: "/app/governance", label: "Governance", description: "Charter proposals, thresholds and timelocks", icon: "governance", section: "workspace", roles: governanceRoles },
  { href: "/app/audit", label: "Audit trail", description: "Indexed canonical protocol evidence", icon: "audit", section: "workspace" },
  { href: "/app/chain", label: "Network", description: "Besu network and contract status", icon: "chain", section: "workspace" },
  { href: "/app/intelligence", label: "Intelligence", description: "Non-authoritative investigation assistance", icon: "intelligence", section: "workspace" },
  { href: "/app/team", label: "Team", description: "Organization membership and access", icon: "team", section: "organization" },
  { href: "/app/settings", label: "Settings", description: "Profile and workspace preferences", icon: "settings", section: "organization" },
];

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TP";
}

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === "/app" : pathname === href || pathname.startsWith(`${href}/`);
}

function pageName(pathname: string) {
  const match = nav.find((item) => isActive(pathname, item.href));
  return match?.label ?? "Workspace";
}

type Props = {
  children: ReactNode;
  organizationName?: string;
  organizationRole?: string;
  memberRole?: string;
  roleKeys: string[];
  userName: string;
  email: string;
};

export function AppShell({ children, organizationName, organizationRole, memberRole, roleKeys, userName, email }: Props) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const currentPage = useMemo(() => pageName(pathname), [pathname]);
  const visibleNav = useMemo(() => nav.filter((item) => !item.roles || item.roles.some((role) => roleKeys.includes(role))), [roleKeys]);
  const commands = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    if (!query) return visibleNav;
    return visibleNav.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query));
  }, [paletteQuery, visibleNav]);

  useEffect(() => {
    setMobileOpen(false);
    setPaletteOpen(false);
    setPaletteQuery("");
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      } else if (!typing && event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderNav = (section: NavItem["section"]) => visibleNav.filter((item) => item.section === section).map((item) => {
    const active = isActive(pathname, item.href);
    const Icon = iconMap[item.icon];
    return (
      <Tooltip.Root key={item.href}>
        <Tooltip.Trigger asChild>
          <Link href={item.href} className={clsx("sidebar-link", active && "active")} aria-current={active ? "page" : undefined}>
            <span className="nav-icon"><Icon size={17} strokeWidth={1.8} /></span>
            <span className="sidebar-link-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
            <span className="nav-active-rail" aria-hidden="true" />
          </Link>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tp-tooltip" side="right" sideOffset={10} collisionPadding={12}>
            <strong>{item.label}</strong>
            <span>{item.description}</span>
            <Tooltip.Arrow className="tp-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    );
  });

  return (
    <Tooltip.Provider delayDuration={420} skipDelayDuration={120}>
      <div className="app-frame premium-product-shell">
        <button className={clsx("sidebar-backdrop", mobileOpen && "visible")} aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
        <aside className={clsx("sidebar", mobileOpen && "open")}>
          <div className="sidebar-head">
            <Link href="/app" className="sidebar-brand">
              <span className="brand-mark"><ShieldCheck size={19} strokeWidth={1.9} /></span>
              <span><strong>ThreadProof</strong><small>Production assurance</small></span>
            </Link>
            <button className="sidebar-close" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><X size={18} /></button>
          </div>

          <button className="sidebar-command" type="button" onClick={() => setPaletteOpen(true)} aria-label="Search workspace">
            <Search size={15} />
            <span>Search workspace</span>
            <kbd><Command size={11} />K</kbd>
          </button>

          <div className="sidebar-section-label">Workspace</div>
          <nav className="sidebar-nav" aria-label="Product navigation">{renderNav("workspace")}</nav>
          <div className="sidebar-section-label sidebar-secondary-label">Organization</div>
          <nav className="sidebar-nav" aria-label="Organization navigation">{renderNav("organization")}</nav>

          <div className="sidebar-footer">
            {organizationName ? (
              <div className="org-card premium-org-card">
                <span className="avatar org-avatar">{initials(organizationName)}</span>
                <div><strong>{organizationName}</strong><small>{[organizationRole, memberRole].filter(Boolean).join(" · ")}</small></div>
              </div>
            ) : null}
            <div className="user-card premium-user-card">
              <span className="avatar">{initials(userName || email)}</span>
              <div><strong>{userName || email}</strong><small>{email}</small></div>
            </div>
            <form action="/auth/signout" method="post">
              <button className="sidebar-signout" type="submit"><span>Sign out</span><LogOut size={14} /></button>
            </form>
          </div>
        </aside>

        <div className="app-content">
          <header className="desktop-appbar">
            <div className="desktop-appbar-title">
              <span>{organizationName ?? "Consortium workspace"}</span>
              <strong>{currentPage}</strong>
            </div>
            <div className="desktop-appbar-actions">
              <button className="topbar-search" type="button" onClick={() => setPaletteOpen(true)}>
                <Search size={14} /><span>Search</span><kbd><Command size={10} />K</kbd>
              </button>
              <span className="protocol-guard"><ShieldCheck size={14} /><span>Chain-enforced authority</span></span>
            </div>
          </header>

          <header className="mobile-appbar">
            <button className="mobile-menu" type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
            <div><small>{organizationName ?? "ThreadProof"}</small><strong>{currentPage}</strong></div>
            <button className="mobile-search" type="button" aria-label="Search workspace" onClick={() => setPaletteOpen(true)}><Search size={17} /></button>
          </header>

          <motion.main
            className="app-main"
            key={pathname}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {children}
          </motion.main>
        </div>

        <AnimatePresence>
          {paletteOpen ? (
            <motion.div
              className="command-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              onMouseDown={() => setPaletteOpen(false)}
            >
              <motion.section
                className="command-palette"
                role="dialog"
                aria-modal="true"
                aria-label="Workspace search"
                initial={{ opacity: 0, y: -10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.985 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="command-search-row">
                  <Search size={18} />
                  <input
                    autoFocus
                    value={paletteQuery}
                    onChange={(event) => setPaletteQuery(event.target.value)}
                    placeholder="Search pages and workflows…"
                    aria-label="Search pages and workflows"
                  />
                  <kbd>ESC</kbd>
                </div>
                <div className="command-results" role="listbox">
                  {commands.length ? commands.map((item) => {
                    const Icon = iconMap[item.icon];
                    return (
                      <Link className="command-result" href={item.href} key={item.href} onClick={() => setPaletteOpen(false)}>
                        <span className="command-result-icon"><Icon size={17} /></span>
                        <span><strong>{item.label}</strong><small>{item.description}</small></span>
                        <ArrowRight size={15} />
                      </Link>
                    );
                  }) : <div className="command-empty"><Search size={20} /><strong>No matching workspace</strong><span>Try an order, proof, credential, governance, or network term.</span></div>}
                </div>
                <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> browse</span><span><kbd>↵</kbd> open</span><span>Authority remains enforced by RLS and chain state.</span></footer>
              </motion.section>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </Tooltip.Provider>
  );
}
