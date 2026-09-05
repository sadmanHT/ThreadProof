"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { redirectAfterAction } from "@/lib/action-redirect.server";
import { buildApplicationUrl } from "@/lib/application-origin.server";
import { createClient } from "@/lib/supabase/server";
import { hasOperationalRole, requireConsortiumViewer } from "@/lib/viewer";

const orderSchema = z.object({
  buyerOrganizationId: z.string().uuid(),
  factoryOrganizationId: z.string().uuid(),
  externalReference: z.string().trim().min(1).max(120),
  title: z.string().trim().min(2).max(180),
  productCategory: z.string().trim().max(120).optional(),
  quantity: z.coerce.number().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(30),
  requestedDeliveryDate: z.string().optional(),
});

function orderInput(formData: FormData) {
  return {
    buyerOrganizationId: formData.get("buyerOrganizationId"),
    factoryOrganizationId: formData.get("factoryOrganizationId"),
    externalReference: formData.get("externalReference"),
    title: formData.get("title"),
    productCategory: formData.get("productCategory") || undefined,
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    requestedDeliveryDate: formData.get("requestedDeliveryDate") || undefined,
  };
}

export async function createOrderAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || active.organization.role !== "buyer" || !hasOperationalRole(active)) {
    redirectAfterAction("/app/orders?error=Switch+to+an+active+buyer+operator+organization+to+create+orders.");
  }

  const parsed = orderSchema.safeParse(orderInput(formData));
  if (!parsed.success) redirectAfterAction("/app/orders/new?error=Check+the+order+details+and+try+again.");
  if (parsed.data.buyerOrganizationId !== active.organization_id) {
    redirectAfterAction("/app/orders/new?error=The+buyer+must+match+your+active+organization+context.");
  }

  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("create_purchase_order_draft", {
    buyer_organization_id: parsed.data.buyerOrganizationId,
    factory_organization_id: parsed.data.factoryOrganizationId,
    external_reference: parsed.data.externalReference,
    title: parsed.data.title,
    product_category: parsed.data.productCategory ?? "",
    quantity: parsed.data.quantity,
    unit: parsed.data.unit,
    ...(parsed.data.requestedDeliveryDate ? { requested_delivery_date: parsed.data.requestedDeliveryDate } : {}),
  });
  if (error || !id) redirectAfterAction(`/app/orders/new?error=${encodeURIComponent(error?.message ?? "Unable to create order")}`);
  revalidatePath("/app/orders");
  redirectAfterAction(`/app/orders/${id}`);
}

export async function updateOrderAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || active.organization.role !== "buyer" || !hasOperationalRole(active)) {
    redirectAfterAction("/app/orders?error=Switch+to+the+buyer+operator+organization+for+this+draft.");
  }

  const orderId = z.string().uuid().safeParse(formData.get("orderId"));
  const parsed = orderSchema.omit({ buyerOrganizationId: true, factoryOrganizationId: true }).safeParse({
    externalReference: formData.get("externalReference"),
    title: formData.get("title"),
    productCategory: formData.get("productCategory") || undefined,
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    requestedDeliveryDate: formData.get("requestedDeliveryDate") || undefined,
  });
  if (!orderId.success || !parsed.success) redirectAfterAction("/app/orders?error=Invalid+draft+update.");

  const supabase = await createClient();
  const { data: order } = await supabase.from("purchase_orders").select("buyer_organization_id").eq("id", orderId.data).maybeSingle();
  if (!order || order.buyer_organization_id !== active.organization_id) {
    redirectAfterAction("/app/orders?error=This+draft+is+outside+your+active+buyer+organization+context.");
  }

  const { error } = await supabase.rpc("update_purchase_order_draft", {
    target_order_id: orderId.data,
    new_external_reference: parsed.data.externalReference,
    new_title: parsed.data.title,
    new_product_category: parsed.data.productCategory ?? "",
    new_quantity: parsed.data.quantity,
    new_unit: parsed.data.unit,
    ...(parsed.data.requestedDeliveryDate ? { new_requested_delivery_date: parsed.data.requestedDeliveryDate } : {}),
  });
  if (error) redirectAfterAction(`/app/orders/${orderId.data}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/orders");
  redirectAfterAction(`/app/orders/${orderId.data}?message=Draft+updated.`);
}

export async function deleteOrderAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || active.organization.role !== "buyer" || !hasOperationalRole(active)) {
    redirectAfterAction("/app/orders?error=Switch+to+the+buyer+operator+organization+for+this+draft.");
  }

  const parsed = z.string().uuid().safeParse(formData.get("orderId"));
  if (!parsed.success) redirectAfterAction("/app/orders?error=Invalid+order.");
  const supabase = await createClient();
  const { data: order } = await supabase.from("purchase_orders").select("buyer_organization_id").eq("id", parsed.data).maybeSingle();
  if (!order || order.buyer_organization_id !== active.organization_id) {
    redirectAfterAction("/app/orders?error=This+draft+is+outside+your+active+buyer+organization+context.");
  }

  const { error } = await supabase.rpc("delete_purchase_order_draft", { target_order_id: parsed.data });
  if (error) redirectAfterAction(`/app/orders/${parsed.data}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/orders");
  redirectAfterAction("/app/orders?message=Draft+deleted.");
}

export async function queueProofAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  if (!active || active.organization.role !== "factory" || !hasOperationalRole(active)) {
    redirectAfterAction("/app/proofs?error=Switch+to+an+active+factory+operator+organization+to+queue+proofs.");
  }

  const parsed = z.object({ orderVersionId: z.string().uuid(), capacityOpeningId: z.string().uuid() }).safeParse({
    orderVersionId: formData.get("orderVersionId"),
    capacityOpeningId: formData.get("capacityOpeningId"),
  });
  if (!parsed.success) redirectAfterAction("/app/proofs?error=Select+an+order+version+and+capacity+state.");
  const supabase = await createClient();
  const [{ data: opening }, { data: version }] = await Promise.all([
    supabase.from("private_capacity_openings").select("factory_organization_id").eq("id", parsed.data.capacityOpeningId).maybeSingle(),
    supabase.from("order_versions").select("purchase_order_id").eq("id", parsed.data.orderVersionId).maybeSingle(),
  ]);
  if (!opening || opening.factory_organization_id !== active.organization_id || !version) {
    redirectAfterAction("/app/proofs?error=The+selected+proof+inputs+are+outside+your+active+factory+context.");
  }
  const { data: order } = await supabase.from("purchase_orders").select("factory_organization_id").eq("id", version.purchase_order_id).maybeSingle();
  if (!order || order.factory_organization_id !== active.organization_id) {
    redirectAfterAction("/app/proofs?error=The+order+version+is+not+assigned+to+your+active+factory+organization.");
  }

  const { error } = await supabase.rpc("queue_capacity_proof", {
    target_order_version_id: parsed.data.orderVersionId,
    target_capacity_opening_id: parsed.data.capacityOpeningId,
  });
  if (error) redirectAfterAction(`/app/proofs?error=${encodeURIComponent(error.message)}`);
  redirectAfterAction("/app/proofs?message=Proof+job+queued.+The+worker+must+generate+and+submit+the+proof.");
}

export type InviteState = { ok: boolean; message: string; inviteUrl?: string };

export async function createInvitationAction(_previous: InviteState, formData: FormData): Promise<InviteState> {
  const viewer = await requireConsortiumViewer();
  const active = viewer.activeMembership;
  const parsed = z.object({
    organizationId: z.string().uuid(),
    email: z.string().trim().email(),
    memberRole: z.enum(["admin", "operator", "viewer", "signer"]),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    email: formData.get("email"),
    memberRole: formData.get("memberRole"),
  });
  if (!parsed.success) return { ok: false, message: "Enter a valid email and member role." };
  if (!active || active.member_role !== "admin" || parsed.data.organizationId !== active.organization_id || active.organization.status !== "active") {
    return { ok: false, message: "Switch to the active organization you administer before creating an invitation." };
  }

  let applicationOrigin: string;
  try {
    applicationOrigin = buildApplicationUrl("/");
  } catch {
    return { ok: false, message: "The application origin is not configured safely. Set NEXT_PUBLIC_APP_URL before creating invitations." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization_invitation", {
    target_organization_id: parsed.data.organizationId,
    invite_email: parsed.data.email,
    invite_member_role: parsed.data.memberRole,
    expires_in_hours: 72,
  });
  if (error || !data?.[0]) return { ok: false, message: error?.message ?? "Unable to create invitation." };

  const inviteUrl = new URL(`/invite/${data[0].invite_token}`, applicationOrigin).toString();
  return { ok: true, message: `Invitation created for ${parsed.data.email}. It expires in 72 hours.`, inviteUrl };
}

export async function updateProfileAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const parsed = z.object({ displayName: z.string().trim().max(100), jobTitle: z.string().trim().max(120) }).safeParse({
    displayName: formData.get("displayName") ?? "",
    jobTitle: formData.get("jobTitle") ?? "",
  });
  if (!parsed.success) redirectAfterAction("/app/settings?error=Invalid+profile+details.");
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({
    display_name: parsed.data.displayName || null,
    job_title: parsed.data.jobTitle || null,
    updated_at: new Date().toISOString(),
  }).eq("id", viewer.userId);
  if (error) redirectAfterAction(`/app/settings?error=${encodeURIComponent(error.message)}`);
  redirectAfterAction("/app/settings?message=Profile+updated.");
}
