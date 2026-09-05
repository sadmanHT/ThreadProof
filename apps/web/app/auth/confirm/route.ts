import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { buildApplicationUrl } from "@/lib/application-origin.server";
import { safeLocalPath } from "@/lib/safe-local-path";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const next = safeLocalPath(request.nextUrl.searchParams.get("next"));

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      return NextResponse.redirect(buildApplicationUrl(next));
    }
  }

  const destination = new URL(buildApplicationUrl("/login"));
  destination.searchParams.set("error", "The confirmation link is invalid or expired.");
  return NextResponse.redirect(destination);
}
