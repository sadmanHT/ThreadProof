import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";
import { AppShell } from "@/components/app-shell";
import { ContentNavigationProgress } from "@/components/content-navigation-progress";
import { OrganizationContextBar } from "@/components/organization-context-bar";

export const dynamic = "force-dynamic";

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const organizationProps = active ? {
    organizationName: active.organization.display_name,
    organizationRole: titleCase(active.organization.role),
    memberRole: titleCase(active.member_role),
  } : {};
  const activeOrganizationProps = active ? { activeOrganizationId: active.organization_id } : {};
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
      roleKeys={roleKeys}
      userName={viewer.profile?.display_name || viewer.email}
      email={viewer.email}
    >
      <ContentNavigationProgress />
      <OrganizationContextBar
        {...activeOrganizationProps}
        organizations={organizationOptions}
      />
      {children}
    </AppShell>
  );
}
