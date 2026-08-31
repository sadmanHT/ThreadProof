import { NextResponse } from "next/server";
import { getBlockchainStatus } from "@/lib/blockchain";
import { createServiceClient } from "@/lib/supabase/service.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function databaseReady() {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from("organizations").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

export async function GET() {
  const [databaseOnline, chain] = await Promise.all([databaseReady(), getBlockchainStatus()]);
  const deployment = process.env.THREADPROOF_DEPLOYMENT_ENV ?? process.env.NODE_ENV ?? "development";
  const chainRequired = deployment === "production" || Boolean(process.env.THREADPROOF_RPC_URL);
  const ready = databaseOnline && (!chainRequired || chain.online);

  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      checks: {
        database: { online: databaseOnline },
        chain: {
          required: chainRequired,
          configured: chain.configured,
          online: chain.online,
          chainId: chain.chainId,
          expectedChainId: chain.expectedChainId,
          blockNumber: chain.blockNumber,
        },
      },
      build: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? process.env.GIT_COMMIT_SHA?.slice(0, 12) ?? null,
      },
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
