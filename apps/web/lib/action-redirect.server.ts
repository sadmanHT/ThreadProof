import { redirect } from "next/navigation";
import { safeLocalPath } from "@/lib/safe-local-path";

/**
 * Server Actions in Next 15 can intermittently strand the Flight transition when
 * they redirect directly back to the route that submitted the action. Always
 * leave the submitting route first, then let /app/continue perform a normal HTTP
 * redirect to the validated local destination.
 */
export function redirectAfterAction(target: string): never {
  const safeTarget = safeLocalPath(target);
  redirect(`/app/continue?next=${encodeURIComponent(safeTarget)}`);
}
