import { createClient } from "@supabase/supabase-js";

export function createServiceClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-threadproof-service": "worker" } },
  });
}
