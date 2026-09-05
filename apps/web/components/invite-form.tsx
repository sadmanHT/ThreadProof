"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createInvitationAction, type InviteState } from "@/app/app/actions";

const initialState: InviteState = { ok: false, message: "" };

export function InviteForm({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(createInvitationAction, initialState);

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [router, state.ok]);

  return (
    <div className="invite-widget">
      <form action={action} className="inline-form invite-grid" aria-busy={pending || undefined}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Email<input name="email" type="email" required placeholder="colleague@example.com" disabled={pending} /></label>
        <label>Role<select name="memberRole" defaultValue="viewer" disabled={pending}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="signer">Signer</option><option value="admin">Admin</option></select></label>
        <button className="button secondary" disabled={pending} aria-busy={pending || undefined}>{pending ? "Creating…" : "Create invitation"}</button>
      </form>
      {state.message ? <div className={`alert ${state.ok ? "alert-success" : "alert-error"}`} role={state.ok ? "status" : "alert"}>{state.message}</div> : null}
      {state.inviteUrl ? <label className="invite-link">One-time invite link<input readOnly value={state.inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label> : null}
    </div>
  );
}
