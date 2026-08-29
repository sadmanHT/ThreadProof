import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const next = request.nextUrl.searchParams.get("next") ?? "/app";
  const destination = request.nextUrl.clone();
  destination.search = "";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      destination.pathname = next.startsWith("/") && !next.startsWith("//") ? next : "/app";
      return NextResponse.redirect(destination);
    }
  }

  destination.pathname = "/login";
  destination.searchParams.set("error", "The confirmation link is invalid or expired.");
  return NextResponse.redirect(destination);
}
