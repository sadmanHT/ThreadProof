import { NextResponse } from "next/server";
import { getTransactionProvenance } from "@/lib/blockchain";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ hash: string }> };

export async function GET(_request: Request, context: Context) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!viewer.isConsortiumMember) {
    return NextResponse.json({ error: "Active consortium membership required" }, { status: 403 });
  }

  const { hash } = await context.params;
  const provenance = await getTransactionProvenance(hash);
  const status = provenance.status === "unavailable" ? 503 : provenance.status === "not_found" ? 404 : 200;
  return NextResponse.json(provenance, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
