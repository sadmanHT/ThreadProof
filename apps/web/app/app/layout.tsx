import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const organizationProps = active ? {
    organizationName: active.organization.display_name,
    organizationRole: titleCase(active.organization.role),
    memberRole: titleCase(active.member_role),
    activeOrganizationId: active.organization_id,
  } : {};
  const roleKeys = active ? [active.organization.role] : [];
  const organizationOptions = viewer.memberships.map((membership) => ({
    id: membership.organization_id,
    name: membership.organization.display_name,
    role: titleCase(membership.organization.role),
    memberRole: titleCase(membership.member_role),
  }));

  return (
    <AppShell
      {...organizationProps}
      organizationOptions={organizationOptions}
      roleKeys={roleKeys}
      userName={viewer.profile?.display_name || viewer.email}
      email={viewer.email}
    >
      {children}
    </AppShell>
  );
}
