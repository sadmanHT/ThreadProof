"use client";

import { useActionState } from "react";
import { createInvitationAction, type InviteState } from "@/app/app/actions";

const initialState: InviteState = { ok: false, message: "" };

export function InviteForm({ organizationId }: { organizationId: string }) {
  const [state, action, pending] = useActionState(createInvitationAction, initialState);
  return (
    <div className="invite-widget">
      <form action={action} className="inline-form invite-grid">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Email<input name="email" type="email" required placeholder="colleague@example.com" /></label>
        <label>Role<select name="memberRole" defaultValue="viewer"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="signer">Signer</option><option value="admin">Admin</option></select></label>
        <button className="button secondary" disabled={pending}>{pending ? "Creating…" : "Create invitation"}</button>
      </form>
      {state.message ? <div className={`alert ${state.ok ? "alert-success" : "alert-error"}`}>{state.message}</div> : null}
      {state.inviteUrl ? <label className="invite-link">One-time invite link<input readOnly value={state.inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label> : null}
    </div>
  );
}
