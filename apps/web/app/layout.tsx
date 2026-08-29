import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ThreadProof",
  description: "Confidential capacity governance for responsible apparel supply chains",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
