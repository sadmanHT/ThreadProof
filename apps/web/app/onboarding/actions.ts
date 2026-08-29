"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireViewer } from "@/lib/viewer";

const onboardingSchema = z.object({
  legalName: z.string().trim().min(2).max(180),
  displayName: z.string().trim().min(2).max(100),
  role: z.enum(["buyer", "factory", "auditor", "regulator", "industry", "labor_representative", "independent"]),
  countryCode: z.string().trim().toUpperCase().length(2).or(z.literal("")),
  notes: z.string().trim().max(1000).optional(),
});

export async function submitOnboardingRequest(formData: FormData) {
  const viewer = await requireViewer();
  if (viewer.isConsortiumMember) redirect("/app");

  const parsed = onboardingSchema.safeParse({
    legalName: formData.get("legalName"),
    displayName: formData.get("displayName"),
    role: formData.get("role"),
    countryCode: formData.get("countryCode") ?? "",
    notes: formData.get("notes") || undefined,
  });
  if (!parsed.success) redirect("/onboarding?error=Check+the+organization+details+and+try+again.");

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("organization_onboarding_requests")
    .select("id")
    .eq("requested_by", viewer.userId)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) redirect("/onboarding?message=A+request+is+already+pending.");

  const { error } = await supabase.from("organization_onboarding_requests").insert({
    requested_by: viewer.userId,
    legal_name: parsed.data.legalName,
    display_name: parsed.data.displayName,
    requested_role: parsed.data.role,
    country_code: parsed.data.countryCode || null,
    notes: parsed.data.notes ?? null,
    status: "pending",
  });
  if (error) redirect(`/onboarding?error=${encodeURIComponent(error.message)}`);
  redirect("/onboarding?message=Request+submitted.+A+consortium+operator+must+approve+and+anchor+the+organization+on-chain.");
}
