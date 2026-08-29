import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";
import { createOrderAction } from "@/app/app/actions";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = "force-dynamic";

export default async function NewOrderPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const buyers = viewer.memberships.filter((membership) => membership.organization.role === "buyer" && hasOperationalRole(membership));
  if (!buyers.length) redirect("/app/orders?error=Buyer+operator+membership+is+required+to+create+orders.");
  const supabase = await createClient();
  const { data: factories } = await supabase.from("organizations").select("id,display_name,country_code,status").eq("role", "factory").eq("status", "active").order("display_name");
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <div className="workspace-page">
      <header className="page-header compact"><div><span className="kicker">BUYER WORKFLOW</span><h1>Create draft order</h1><p>Capture counterparty metadata first. No capacity or authorization claim is made at this step.</p></div></header>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <section className="panel form-panel"><form className="stack-form" action={createOrderAction}>
        <div className="field-grid two"><label>Buyer organization<select name="buyerOrganizationId" required>{buyers.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.display_name}</option>)}</select></label><label>Primary factory<select name="factoryOrganizationId" required defaultValue=""><option value="" disabled>Select factory</option>{(factories ?? []).map((factory) => <option key={factory.id} value={factory.id}>{factory.display_name}{factory.country_code ? ` · ${factory.country_code}` : ""}</option>)}</select></label></div>
        <div className="field-grid two"><label>External reference<input name="externalReference" required placeholder="PO-2026-1042" /></label><label>Order title<input name="title" required placeholder="30,000 polo shirts" /></label></div>
        <div className="field-grid three"><label>Product category<input name="productCategory" placeholder="Polo shirt" /></label><label>Quantity<input name="quantity" type="number" min="0.001" step="0.001" required /></label><label>Unit<input name="unit" defaultValue="pieces" required /></label></div>
        <label>Requested delivery date<input name="requestedDeliveryDate" type="date" /></label>
        <div className="callout"><strong>What happens next?</strong><span>The buyer prepares an encrypted order version and signs its EIP-712 authorization. The OrderRegistry commitment then becomes the version a PoFC proof must bind to.</span></div>
        <div className="form-actions"><button className="button primary">Create private draft</button><a className="button ghost" href="/app/orders">Cancel</a></div>
      </form></section>
    </div>
  );
}
