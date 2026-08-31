import type { Metadata } from "next";
import "./globals.css";
import "./workflow.css";
import "./premium.css";

export const metadata: Metadata = {
  title: { default: "ThreadProof", template: "%s · ThreadProof" },
  description: "Privacy-preserving production authorization for responsible apparel supply chains.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
