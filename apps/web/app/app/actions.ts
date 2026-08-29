"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";

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
  await requireConsortiumViewer();
  const parsed = orderSchema.safeParse(orderInput(formData));
  if (!parsed.success) redirect("/app/orders/new?error=Check+the+order+details+and+try+again.");

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
  if (error || !id) redirect(`/app/orders/new?error=${encodeURIComponent(error?.message ?? "Unable to create order")}`);
  revalidatePath("/app/orders");
  redirect(`/app/orders/${id}`);
}

export async function updateOrderAction(formData: FormData) {
  await requireConsortiumViewer();
  const orderId = z.string().uuid().safeParse(formData.get("orderId"));
  const parsed = orderSchema.omit({ buyerOrganizationId: true, factoryOrganizationId: true }).safeParse({
    externalReference: formData.get("externalReference"),
    title: formData.get("title"),
    productCategory: formData.get("productCategory") || undefined,
    quantity: formData.get("quantity"),
    unit: formData.get("unit"),
    requestedDeliveryDate: formData.get("requestedDeliveryDate") || undefined,
  });
  if (!orderId.success || !parsed.success) redirect("/app/orders?error=Invalid+draft+update.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_purchase_order_draft", {
    target_order_id: orderId.data,
    new_external_reference: parsed.data.externalReference,
    new_title: parsed.data.title,
    new_product_category: parsed.data.productCategory ?? "",
    new_quantity: parsed.data.quantity,
    new_unit: parsed.data.unit,
    ...(parsed.data.requestedDeliveryDate ? { new_requested_delivery_date: parsed.data.requestedDeliveryDate } : {}),
  });
  if (error) redirect(`/app/orders/${orderId.data}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/app/orders/${orderId.data}`);
  revalidatePath("/app/orders");
  redirect(`/app/orders/${orderId.data}?message=Draft+updated.`);
}

export async function deleteOrderAction(formData: FormData) {
  await requireConsortiumViewer();
  const parsed = z.string().uuid().safeParse(formData.get("orderId"));
  if (!parsed.success) redirect("/app/orders?error=Invalid+order.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_purchase_order_draft", { target_order_id: parsed.data });
  if (error) redirect(`/app/orders/${parsed.data}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/orders");
  redirect("/app/orders?message=Draft+deleted.");
}

export async function queueProofAction(formData: FormData) {
  await requireConsortiumViewer();
  const parsed = z.object({ orderVersionId: z.string().uuid(), capacityOpeningId: z.string().uuid() }).safeParse({
    orderVersionId: formData.get("orderVersionId"),
    capacityOpeningId: formData.get("capacityOpeningId"),
  });
  if (!parsed.success) redirect("/app/proofs?error=Select+an+order+version+and+capacity+state.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("queue_capacity_proof", {
    target_order_version_id: parsed.data.orderVersionId,
    target_capacity_opening_id: parsed.data.capacityOpeningId,
  });
  if (error) redirect(`/app/proofs?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/proofs");
  redirect("/app/proofs?message=Proof+job+queued.+The+worker+must+generate+and+submit+the+proof.");
}

export type InviteState = { ok: boolean; message: string; inviteUrl?: string };

export async function createInvitationAction(_previous: InviteState, formData: FormData): Promise<InviteState> {
  await requireConsortiumViewer();
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

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization_invitation", {
    target_organization_id: parsed.data.organizationId,
    invite_email: parsed.data.email,
    invite_member_role: parsed.data.memberRole,
    expires_in_hours: 72,
  });
  if (error || !data?.[0]) return { ok: false, message: error?.message ?? "Unable to create invitation." };

  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const inviteUrl = `${protocol}://${host}/invite/${data[0].invite_token}`;
  return { ok: true, message: `Invitation created for ${parsed.data.email}. It expires in 72 hours.`, inviteUrl };
}

export async function updateProfileAction(formData: FormData) {
  const viewer = await requireConsortiumViewer();
  const parsed = z.object({ displayName: z.string().trim().max(100), jobTitle: z.string().trim().max(120) }).safeParse({
    displayName: formData.get("displayName") ?? "",
    jobTitle: formData.get("jobTitle") ?? "",
  });
  if (!parsed.success) redirect("/app/settings?error=Invalid+profile+details.");
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({
    display_name: parsed.data.displayName || null,
    job_title: parsed.data.jobTitle || null,
    updated_at: new Date().toISOString(),
  }).eq("id", viewer.userId);
  if (error) redirect(`/app/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/settings");
  redirect("/app/settings?message=Profile+updated.");
}
