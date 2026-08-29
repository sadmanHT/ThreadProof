"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireViewer } from "@/lib/viewer";

export async function acceptInvitationAction(formData: FormData) {
  await requireViewer();
  const token = String(formData.get("token") ?? "");
  if (!/^[0-9a-f]{48}$/i.test(token)) redirect("/onboarding?error=Invalid+invitation+token.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_organization_invitation", { invite_token: token });
  if (error) redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  redirect("/app");
}
