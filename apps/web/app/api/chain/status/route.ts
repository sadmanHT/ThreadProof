import { NextResponse } from "next/server";
import { getBlockchainStatus } from "@/lib/blockchain";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!viewer.isConsortiumMember) {
    return NextResponse.json({ error: "Active consortium membership required" }, { status: 403 });
  }

  const status = await getBlockchainStatus();
  return NextResponse.json(status, {
    status: status.online ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
