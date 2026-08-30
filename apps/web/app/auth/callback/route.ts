import { NextResponse, type NextRequest } from "next/server";
import { safeLocalPath } from "@/lib/safe-local-path";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeLocalPath(request.nextUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.nextUrl.origin));
    }
  }

  const destination = request.nextUrl.clone();
  destination.pathname = "/login";
  destination.search = "";
  destination.searchParams.set("error", "Unable to complete sign in.");
  return NextResponse.redirect(destination);
}
