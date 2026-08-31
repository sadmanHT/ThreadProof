import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireConsortiumViewer();
  const primary = viewer.memberships[0];
  return (
    <AppShell
      organizationName={primary?.organization.display_name}
      organizationRole={primary ? titleCase(primary.organization.role) : undefined}
      memberRole={primary ? titleCase(primary.member_role) : undefined}
      userName={viewer.profile?.display_name || viewer.email}
      email={viewer.email}
    >
      {children}
    </AppShell>
  );
}
