import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

type Organization = Database["public"]["Tables"]["organizations"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type MembershipRow = Database["public"]["Tables"]["organization_members"]["Row"];

export const ACTIVE_ORGANIZATION_COOKIE = "threadproof-active-organization";

export type ViewerMembership = MembershipRow & { organization: Organization };

export type Viewer = {
  userId: string;
  email: string;
  profile: Profile | null;
  memberships: ViewerMembership[];
  activeMembership: ViewerMembership | null;
  roles: Set<Database["public"]["Enums"]["organization_role"]>;
  isConsortiumMember: boolean;
};

export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsError ? null : claimsData?.claims;
  const userId = typeof claims?.sub === "string" ? claims.sub : null;

  if (!userId) return null;

  const [{ data: profile }, { data: memberRows }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
    supabase
      .from("organization_members")
      .select("organization_id,user_id,member_role,active,created_at")
      .eq("user_id", userId)
      .eq("active", true),
  ]);

  const organizationIds = (memberRows ?? []).map((membership) => membership.organization_id);
  const { data: organizations } = organizationIds.length
    ? await supabase.from("organizations").select("*").in("id", organizationIds)
    : { data: [] as Organization[] };

  const organizationById = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
  const memberships: ViewerMembership[] = (memberRows ?? []).flatMap((membership) => {
    const organization = organizationById.get(membership.organization_id);
    return organization ? [{ ...membership, organization }] : [];
  });

  const cookieStore = await cookies();
  const requestedOrganizationId = cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value;
  const activeMembership = memberships.find((membership) => membership.organization_id === requestedOrganizationId)
    ?? memberships[0]
    ?? null;
  const orderedMemberships = activeMembership
    ? [activeMembership, ...memberships.filter((membership) => membership.organization_id !== activeMembership.organization_id)]
    : memberships;
  const roles = new Set(memberships.map((membership) => membership.organization.role));
  const email = typeof claims?.email === "string" ? claims.email : profile?.email ?? "";

  return {
    userId,
    email,
    profile: profile ?? null,
    memberships: orderedMemberships,
    activeMembership,
    roles,
    isConsortiumMember: memberships.length > 0,
  };
}

export async function requireViewer() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export async function requireConsortiumViewer() {
  const viewer = await requireViewer();
  if (!viewer.isConsortiumMember) redirect("/onboarding");
  return viewer;
}

export function hasOperationalRole(membership: ViewerMembership) {
  return membership.active && ["admin", "operator", "signer"].includes(membership.member_role);
}
