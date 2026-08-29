"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const credentialsSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().max(100).optional(),
  next: z.string().optional(),
});

function safeNext(value: string | undefined) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

function authError(message: string, next?: string): never {
  const params = new URLSearchParams({ error: message });
  if (next) params.set("next", safeNext(next));
  redirect(`/login?${params.toString()}`);
}

export async function loginAction(formData: FormData) {
  const next = String(formData.get("next") ?? "");
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password"), next });
  if (!parsed.success) authError("Enter a valid email and password.", next);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error) authError(error.message, parsed.data.next);
  redirect(safeNext(parsed.data.next));
}

export async function signupAction(formData: FormData) {
  const next = String(formData.get("next") ?? "");
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password"), displayName: formData.get("displayName") || undefined, next });
  if (!parsed.success) authError("Use a valid email and a password of at least 8 characters.", next);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email: parsed.data.email, password: parsed.data.password, options: { data: { display_name: parsed.data.displayName ?? null } } });
  if (error) authError(error.message, parsed.data.next);
  if (data.session) redirect(safeNext(parsed.data.next));
  redirect(`/login?message=${encodeURIComponent("Account created. Confirm your email, then sign in.")}`);
}
