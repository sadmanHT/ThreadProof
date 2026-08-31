import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { OrderCreateWizard } from "@/components/order-create-wizard";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = "force-dynamic";

export default async function NewOrderPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || active.organization.role !== "buyer" || !hasOperationalRole(active)) {
    redirect("/app/orders?error=Switch+to+an+active+buyer+operator+organization+to+create+orders.");
  }

  const supabase = await createClient();
  const { data: factories } = await supabase.from("organizations").select("id,display_name,country_code,status").eq("role", "factory").eq("status", "active").order("display_name");
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  return <div className="workspace-page wizard-page">
    {error ? <div className="alert alert-error">{error}</div> : null}
    <OrderCreateWizard
      buyers={[{ id: active.organization_id, displayName: active.organization.display_name }]}
      factories={(factories ?? []).map((factory) => ({ id: factory.id, displayName: factory.display_name, ...(factory.country_code ? { detail: factory.country_code } : {}) }))}
    />
  </div>;
}
