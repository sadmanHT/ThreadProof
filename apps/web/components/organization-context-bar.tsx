"use client";

import { usePathname } from "next/navigation";

type OrganizationOption = {
  id: string;
  name: string;
  role: string;
  memberRole: string;
};

type Props = {
  activeOrganizationId?: string;
  organizations: OrganizationOption[];
};

export function OrganizationContextBar({ activeOrganizationId, organizations }: Props) {
  const pathname = usePathname();
  const active = organizations.find((organization) => organization.id === activeOrganizationId) ?? organizations[0];
  if (!active) return null;

  return (
    <section className="organization-context-bar" aria-label="Active organization context">
      <div className="organization-context-copy">
        <span className="kicker">ACTIVE ORGANIZATION</span>
        <strong>{active.name}</strong>
        <small>{active.role} · {active.memberRole} · UI context only; RLS and on-chain authority remain independently enforced.</small>
      </div>
      {organizations.length > 1 ? (
        <form className="organization-context-form" action="/app/context" method="post">
          <input type="hidden" name="returnTo" value={pathname || "/app"} />
          <label>
            <span>Switch workspace</span>
            <select name="organizationId" defaultValue={active.id}>
              {organizations.map((organization) => (
                <option value={organization.id} key={organization.id}>
                  {organization.name} · {organization.role}
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary compact" type="submit">Switch</button>
        </form>
      ) : (
        <span className="organization-context-single">Single active membership</span>
      )}
    </section>
  );
}
