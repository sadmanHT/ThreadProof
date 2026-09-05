-- Organization suspension must remove mutation authority consistently, including advisory
-- AI review state. The UI already treats suspended organizations as non-operational; enforce
-- the same boundary in the RPC and RLS so direct PostgREST/RPC calls cannot bypass it.

create or replace function public.review_ai_finding(
  target_finding_id uuid,
  target_organization_id uuid,
  new_status text,
  new_review_note text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reviewer_id uuid := (select auth.uid());
begin
  if reviewer_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if new_status not in ('open', 'acknowledged', 'dismissed', 'resolved') then
    raise exception 'Invalid AI finding review status.' using errcode = '22023';
  end if;

  if new_review_note is not null and char_length(new_review_note) > 2000 then
    raise exception 'AI finding review note is too long.' using errcode = '22023';
  end if;

  if not private.has_operational_membership(target_organization_id) then
    raise exception 'An active operator/admin/signer membership in an active organization is required to review AI findings.' using errcode = '42501';
  end if;

  update public.ai_findings finding
  set status = new_status,
      review_note = new_review_note
  where finding.id = target_finding_id
    and finding.organization_id = target_organization_id;

  if not found then
    raise exception 'AI finding is not available for the selected organization.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.review_ai_finding(uuid,uuid,text,text) from public, anon;
grant execute on function public.review_ai_finding(uuid,uuid,text,text) to authenticated;

drop policy if exists ai_findings_operator_review_update on public.ai_findings;
create policy ai_findings_operator_review_update on public.ai_findings
  for update to authenticated
  using (private.has_operational_membership(organization_id))
  with check (private.has_operational_membership(organization_id));
