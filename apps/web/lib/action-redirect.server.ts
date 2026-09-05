import { redirect } from "next/navigation";
import { safeLocalPath } from "@/lib/safe-local-path";

/**
 * Next 15 Server Actions can strand an App Router transition when they redirect
 * directly back to a form route. Leave the submitting route first; the public
 * continuation page then ends the Flight transition and performs a real browser
 * navigation to the validated same-origin destination.
 */
export function redirectAfterAction(target: string): never {
  const safeTarget = safeLocalPath(target);
  redirect(`/action-continue?next=${encodeURIComponent(safeTarget)}`);
}
