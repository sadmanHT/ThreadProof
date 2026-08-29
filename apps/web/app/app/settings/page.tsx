import { requireConsortiumViewer } from "@/lib/viewer";
import { titleCase } from "@/lib/format";
import { updateProfileAction } from "@/app/app/actions";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SettingsPage({ searchParams }: Props) {
  const viewer = await requireConsortiumViewer();
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : null;
  const error = typeof params.error === "string" ? params.error : null;
  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">ACCOUNT</span><h1>Settings</h1><p>Your Supabase identity maps to one or more consortium organization memberships.</p></div></header>{message ? <div className="alert alert-success">{message}</div> : null}{error ? <div className="alert alert-error">{error}</div> : null}<section className="detail-grid"><article className="panel form-panel"><div className="panel-heading"><div><span className="kicker">PROFILE</span><h2>Personal details</h2></div></div><form className="stack-form" action={updateProfileAction}><label>Email<input value={viewer.email} disabled /></label><label>Display name<input name="displayName" defaultValue={viewer.profile?.display_name ?? ""} /></label><label>Job title<input name="jobTitle" defaultValue={viewer.profile?.job_title ?? ""} /></label><button className="button secondary">Save profile</button></form></article><article className="panel"><div className="panel-heading"><div><span className="kicker">MEMBERSHIPS</span><h2>Organization access</h2></div></div><div className="record-list">{viewer.memberships.map((membership) => <div className="record-row" key={membership.organization_id}><div><strong>{membership.organization.display_name}</strong><span>{titleCase(membership.organization.role)} organization</span></div><span className="badge neutral">{titleCase(membership.member_role)}</span></div>)}</div></article></section></div>;
}
