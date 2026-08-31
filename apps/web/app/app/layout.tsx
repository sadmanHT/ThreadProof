import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireConsortiumViewer();
  const primary = viewer.memberships[0];
  const organizationProps = primary ? {
    organizationName: primary.organization.display_name,
    organizationRole: titleCase(primary.organization.role),
    memberRole: titleCase(primary.member_role),
  } : {};
  const roleKeys = [...new Set(viewer.memberships.map((membership) => membership.organization.role))];

  return (
    <AppShell
      {...organizationProps}
      roleKeys={roleKeys}
      userName={viewer.profile?.display_name || viewer.email}
      email={viewer.email}
    >
      {children}
    </AppShell>
  );
}
