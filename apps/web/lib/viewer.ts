import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/database.types";

type Organization = Database["public"]["Tables"]["organizations"]["Row"];
type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type MembershipRow = Database["public"]["Tables"]["organization_members"]["Row"];

export type ViewerMembership = MembershipRow & { organization: Organization };

export type Viewer = {
  userId: string;
  email: string;
  profile: Profile | null;
  memberships: ViewerMembership[];
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

  const roles = new Set(memberships.map((membership) => membership.organization.role));
  const email = typeof claims?.email === "string" ? claims.email : profile?.email ?? "";

  return {
    userId,
    email,
    profile: profile ?? null,
    memberships,
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
