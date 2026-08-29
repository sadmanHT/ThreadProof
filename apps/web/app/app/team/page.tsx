import { createClient } from "@/lib/supabase/server";
import { requireConsortiumViewer } from "@/lib/viewer";
import { formatDate, titleCase } from "@/lib/format";
import { InviteForm } from "@/components/invite-form";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const viewer = await requireConsortiumViewer();
  const supabase = await createClient();
  const organizationIds = viewer.memberships.map((membership) => membership.organization_id);
  const [{ data: members }, { data: invitations }] = await Promise.all([
    supabase.from("organization_members").select("organization_id,user_id,member_role,active,created_at").in("organization_id", organizationIds).order("created_at"),
    supabase.from("organization_invitations").select("id,organization_id,email,member_role,expires_at,accepted_at,created_at").in("organization_id", organizationIds).order("created_at", { ascending: false }).limit(50),
  ]);
  const userIds = [...new Set((members ?? []).map((member) => member.user_id))];
  const { data: profiles } = userIds.length ? await supabase.from("profiles").select("id,email,display_name,job_title").in("id", userIds) : { data: [] };
  const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  const orgMap = new Map(viewer.memberships.map((membership) => [membership.organization_id, membership.organization]));
  const adminMemberships = viewer.memberships.filter((membership) => membership.member_role === "admin" && membership.active);

  return <div className="workspace-page"><header className="page-header"><div><span className="kicker">ORGANIZATION ACCESS</span><h1>Team & membership</h1><p>Application membership controls workspace access. Blockchain signing authority is a separate organization-account relationship.</p></div></header>{adminMemberships.map((membership) => <section className="panel form-panel" key={membership.organization_id}><div className="panel-heading"><div><span className="kicker">ADMIN · {membership.organization.display_name}</span><h2>Invite a member</h2></div></div><InviteForm organizationId={membership.organization_id} /></section>)}<section className="panel table-panel"><div className="panel-heading"><div><span className="kicker">ACTIVE MEMBERS</span><h2>Workspace access</h2></div></div>{(members ?? []).length ? <div className="data-table team-table"><div className="table-row table-head"><span>Member</span><span>Organization</span><span>Role</span><span>Status</span><span>Joined</span></div>{(members ?? []).map((member) => { const profile = profileMap.get(member.user_id); return <div className="table-row" key={`${member.organization_id}-${member.user_id}`}><span><strong>{profile?.display_name || profile?.email || "Member"}</strong><small>{profile?.job_title || profile?.email || member.user_id}</small></span><span>{orgMap.get(member.organization_id)?.display_name ?? "Organization"}</span><span>{titleCase(member.member_role)}</span><span>{member.active ? "Active" : "Inactive"}</span><span>{formatDate(member.created_at)}</span></div>; })}</div> : <div className="empty-state"><strong>No team records available</strong><span>Non-admin members can see their own membership; organization admins can see their team.</span></div>}</section>{adminMemberships.length ? <section className="panel table-panel"><div className="panel-heading"><div><span className="kicker">INVITATIONS</span><h2>Recent invitations</h2></div></div>{(invitations ?? []).length ? <div className="record-list">{(invitations ?? []).map((invitation) => <div className="record-row" key={invitation.id}><div><strong>{invitation.email}</strong><span>{orgMap.get(invitation.organization_id)?.display_name} · {titleCase(invitation.member_role)} · expires {formatDate(invitation.expires_at)}</span></div><span className={`badge ${invitation.accepted_at ? "success" : "warning"}`}>{invitation.accepted_at ? "Accepted" : "Pending"}</span></div>)}</div> : <div className="empty-state"><strong>No invitations yet</strong><span>Create a time-limited invitation above.</span></div>}</section> : null}</div>;
}
