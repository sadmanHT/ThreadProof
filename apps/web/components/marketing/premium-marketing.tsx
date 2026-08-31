"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

const links = [
  ["/protocol", "Protocol"],
  ["/privacy", "Privacy"],
  ["/architecture", "Architecture"],
  ["/#governance", "Governance"],
] as const;

export function ThreadMark({ compact = false }: { compact?: boolean }) {
  return <span className={`tp-thread-mark ${compact ? "compact" : ""}`} aria-hidden="true"><i /><i /><i /></span>;
}

export function MarketingNav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className={`premium-nav-shell ${scrolled ? "scrolled" : ""}`}>
      <nav className="premium-nav" aria-label="Public navigation">
        <Link href="/" className="premium-brand" aria-label="ThreadProof home"><ThreadMark compact /><span>ThreadProof</span></Link>
        <div className={`premium-nav-links ${open ? "open" : ""}`}>
          {links.map(([href, label]) => <Link className={pathname === href ? "active" : undefined} href={href} key={href}>{label}</Link>)}
          <Link href="/demo">Demo</Link>
        </div>
        <div className="premium-nav-actions"><Link className="nav-text-link" href="/login">Sign in</Link><Link className="button premium-cta small" href="/console">Open Console</Link><button type="button" className="premium-menu" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Toggle navigation"><span/><span/></button></div>
      </nav>
    </header>
  );
}

export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className={`premium-reveal ${visible ? "visible" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>;
}

export function PrivacyLabel({ children, tone = "private" }: { children: ReactNode; tone?: "private" | "shared" | "consortium" | "protected" }) {
  return <span className={`privacy-label ${tone}`}><span aria-hidden="true" />{children}</span>;
}

export function MarketingFooter() {
  return <footer className="premium-footer"><div className="premium-footer-main"><div><Link className="premium-brand footer-brand" href="/"><ThreadMark compact /><span>ThreadProof</span></Link><p>Privacy-preserving production authorization for responsible apparel supply chains.</p></div><div className="premium-footer-links"><div><strong>Product</strong><Link href="/protocol">Protocol</Link><Link href="/privacy">Privacy</Link><Link href="/architecture">Architecture</Link></div><div><strong>Access</strong><Link href="/demo">Demo scenario</Link><Link href="/login">Member sign in</Link><Link href="/console">Open console</Link></div></div></div><div className="premium-footer-bottom"><span>© 2026 ThreadProof</span><span>Verify the condition — not the confidential data.</span></div></footer>;
}
