import { NextResponse, type NextRequest } from "next/server";
import { buildApplicationUrl } from "@/lib/application-origin.server";
import { safeLocalPath } from "@/lib/safe-local-path";

export function GET(request: NextRequest) {
  const target = safeLocalPath(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(buildApplicationUrl(target), 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
