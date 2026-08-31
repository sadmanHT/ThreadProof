import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { shortHash, titleCase } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const roleLabels: Record<string, string> = {
  buyer: "Buyer",
  factory: "Factory",
  auditor: "Auditor",
  regulator: "Regulatory participant",
  industry: "Industry representative",
  labor_representative: "Labor standards representative",
  independent: "Independent participant",
};

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TP";
}

export default async function OrganizationsPage({ searchParams }: Props) {
  await requireConsortiumViewer();
  const supabase = await createClient();
  const [{ data: organizations }, { data: credentials }] = await Promise.all([
    supabase.from("organizations").select("id,display_name,legal_name,role,status,country_code,chain_organization_id,created_at").order("display_name"),
    supabase.from("credentials").select("subject_organization_id,status"),
  ]);
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().toLowerCase() : "";
  const role = typeof params.role === "string" ? params.role : "all";
  const status = typeof params.status === "string" ? params.status : "active";
  const activeCredentialCount = new Map<string, number>();
  for (const credential of credentials ?? []) {
    if (credential.status !== "active") continue;
    activeCredentialCount.set(credential.subject_organization_id, (activeCredentialCount.get(credential.subject_organization_id) ?? 0) + 1);
  }
  const filtered = (organizations ?? []).filter((organization) => {
    const matchesQuery = !query || `${organization.display_name} ${organization.legal_name} ${organization.country_code ?? ""}`.toLowerCase().includes(query);
    const matchesRole = role === "all" || organization.role === role;
    const matchesStatus = status === "all" || organization.status === status;
    return matchesQuery && matchesRole && matchesStatus;
  });

  return <div className="workspace-page">
    <header className="page-header"><div><span className="kicker">CONSORTIUM DIRECTORY</span><h1>Organizations</h1><p>Discover consortium participants and the protocol identity information visible to your membership. Private commercial relationships remain permission-scoped.</p></div><span className="directory-count">{filtered.length} visible</span></header>
    <form className="directory-toolbar" method="get"><label className="directory-search"><span className="sr-only">Search organizations</span><input type="search" name="q" defaultValue={typeof params.q === "string" ? params.q : ""} placeholder="Search organizations" /></label><label><span className="sr-only">Role</span><select name="role" defaultValue={role}><option value="all">All roles</option>{Object.entries(roleLabels).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span className="sr-only">Status</span><select name="status" defaultValue={status}><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="revoked">Revoked</option></select></label><button className="button secondary small">Apply filters</button></form>
    {filtered.length ? <section className="directory-grid">{filtered.map((organization) => <Link className="organization-card" href={`/app/organizations/${organization.id}`} key={organization.id}><div className="organization-card-head"><span className="organization-monogram">{initials(organization.display_name)}</span><StatusBadge value={organization.status} /></div><div className="organization-card-body"><span className="kicker">{roleLabels[organization.role] ?? titleCase(organization.role)}</span><h2>{organization.display_name}</h2><p>{organization.legal_name !== organization.display_name ? organization.legal_name : "Registered consortium organization"}</p></div><div className="organization-card-meta"><div><span>Country</span><strong>{organization.country_code ?? "—"}</strong></div><div><span>Active credentials</span><strong>{activeCredentialCount.get(organization.id) ?? 0}</strong></div><div className="wide"><span>Protocol identity</span><strong className="mono">{shortHash(organization.chain_organization_id)}</strong></div></div><span className="organization-card-link">View organization →</span></Link>)}</section> : <section className="panel"><div className="empty-state large"><strong>No organizations match these filters</strong><span>Try a broader role, status or search term. Visibility is still constrained by consortium RLS.</span></div></section>}
    <p className="footnote">Organization identity and credential status are consortium-visible protocol metadata. Purchase orders, private capacity openings and protected identities are governed by separate visibility rules.</p>
  </div>;
}
