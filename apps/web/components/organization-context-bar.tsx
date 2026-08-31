"use client";

import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Building2, ChevronDown, ShieldCheck } from "lucide-react";

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

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TP";
}

export function OrganizationContextBar({ activeOrganizationId, organizations }: Props) {
  const pathname = usePathname();
  const active = organizations.find((organization) => organization.id === activeOrganizationId) ?? organizations[0];
  if (!active) return null;

  return (
    <motion.section
      className="organization-context-bar premium-context-bar"
      aria-label="Active organization context"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="context-identity">
        <span className="context-monogram" aria-hidden="true">{initials(active.name)}</span>
        <div className="organization-context-copy">
          <div className="context-label-row"><span>Active organization</span><i /><span>{active.role}</span></div>
          <strong>{active.name}</strong>
          <small><ShieldCheck size={12} /> UI context only · RLS and on-chain authority remain independently enforced.</small>
        </div>
      </div>

      {organizations.length > 1 ? (
        <form className="organization-context-form premium-context-form" action="/app/context" method="post">
          <input type="hidden" name="returnTo" value={pathname || "/app"} />
          <label className="context-select-shell">
            <Building2 size={15} />
            <span className="sr-only">Switch workspace</span>
            <select name="organizationId" defaultValue={active.id} aria-label="Switch active organization">
              {organizations.map((organization) => (
                <option value={organization.id} key={organization.id}>
                  {organization.name} · {organization.role}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <button className="button context-switch-button" type="submit">Switch</button>
        </form>
      ) : (
        <span className="organization-context-single premium-context-single"><Building2 size={13} /> Single membership</span>
      )}
    </motion.section>
  );
}
