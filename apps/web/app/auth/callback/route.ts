import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next") ?? "/app";
  const destination = request.nextUrl.clone();
  destination.search = "";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      destination.pathname = next.startsWith("/") && !next.startsWith("//") ? next : "/app";
      return NextResponse.redirect(destination);
    }
  }

  destination.pathname = "/login";
  destination.searchParams.set("error", "Unable to complete sign in.");
  return NextResponse.redirect(destination);
}
