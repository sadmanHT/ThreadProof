import type { Metadata } from "next";
import { DemoScenario } from "@/components/marketing/demo-scenario";
import { MarketingFooter, MarketingNav } from "@/components/marketing/premium-marketing";

export const metadata: Metadata = { title: "Demo", description: "A guided ThreadProof demo scenario covering capacity proofs, state reuse prevention, subcontracting, credentials and governance." };

export default function DemoPage() {
  return <main className="premium-page"><MarketingNav /><div className="demo-shell"><div className="demo-stage"><div className="demo-intro"><div><span className="premium-kicker">Guided demo</span><h1>The ThreadProof story,<br/>end to end.</h1><p>Walk through the complete judge-ready scenario without writing to production infrastructure. Every value below is mock demo data; the real console remains chain-gated and permission-scoped.</p></div><span className="demo-mode-pill">Demo mode · no chain writes</span></div><DemoScenario /></div></div><MarketingFooter /></main>;
}
