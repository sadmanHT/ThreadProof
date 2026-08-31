import { NextResponse, type NextRequest } from "next/server";
import { safeLocalPath } from "@/lib/safe-local-path";
import { ACTIVE_ORGANIZATION_COOKIE, getViewer } from "@/lib/viewer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const organizationId = String(form.get("organizationId") ?? "");
  const returnTo = safeLocalPath(String(form.get("returnTo") ?? "/app"));
  const viewer = await getViewer();

  if (!viewer) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", returnTo);
    return NextResponse.redirect(login, 303);
  }

  if (!UUID.test(organizationId)) {
    return NextResponse.json({ error: "Invalid organization context." }, { status: 400 });
  }

  const membership = viewer.memberships.find((item) =>
    item.active && item.organization_id === organizationId,
  );
  if (!membership) {
    return NextResponse.json({ error: "Organization context is not available to this account." }, { status: 403 });
  }

  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/app",
    maxAge: THIRTY_DAYS,
  });
  return response;
}
