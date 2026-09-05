import { NextResponse, type NextRequest } from "next/server";
import { buildApplicationUrl } from "@/lib/application-origin.server";
import { safeLocalPath } from "@/lib/safe-local-path";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeLocalPath(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(buildApplicationUrl(next));
    }
  }

  const destination = new URL(buildApplicationUrl("/login"));
  destination.searchParams.set("error", "Unable to complete sign in.");
  return NextResponse.redirect(destination);
}
