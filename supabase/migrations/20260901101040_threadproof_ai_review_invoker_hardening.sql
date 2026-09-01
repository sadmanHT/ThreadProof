-- Harden AI finding review so authenticated users never invoke owner-privileged
-- code through the exposed public API schema. Authorization is enforced twice:
-- by the public security-invoker RPC and by row-level security on ai_findings.

revoke execute on function public.review_ai_finding(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- Authenticated reviewers may modify only the review inputs. Reviewer identity and
-- timestamp remain protected columns populated by the database trigger below.
revoke update on table public.ai_findings from authenticated;
grant update (status, review_note) on table public.ai_findings to authenticated;

drop policy if exists ai_findings_operator_review_update on public.ai_findings;
create policy ai_findings_operator_review_update
on public.ai_findings
for update
to authenticated
using (
  exists (
    select 1
    from public.organization_members membership
    where membership.organization_id = ai_findings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.active = true
      and membership.member_role in ('admin', 'operator', 'signer')
  )
)
with check (
  exists (
    select 1
    from public.organization_members membership
    where membership.organization_id = ai_findings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.active = true
      and membership.member_role in ('admin', 'operator', 'signer')
  )
);

create or replace function private.stamp_ai_finding_review()
returns trigger
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

  if new.status = 'open' then
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.review_note := null;
  else
    new.reviewed_by := reviewer_id;
    new.reviewed_at := now();
    new.review_note := nullif(btrim(new.review_note), '');
  end if;

  return new;
end;
$$;

revoke all on function private.stamp_ai_finding_review() from public, anon, authenticated, service_role;

drop trigger if exists stamp_ai_finding_review on public.ai_findings;
create trigger stamp_ai_finding_review
before update of status, review_note on public.ai_findings
for each row
execute function private.stamp_ai_finding_review();

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

  if not exists (
    select 1
    from public.organization_members membership
    where membership.user_id = reviewer_id
      and membership.organization_id = target_organization_id
      and membership.active = true
      and membership.member_role in ('admin', 'operator', 'signer')
  ) then
    raise exception 'An active operator/admin/signer membership is required to review AI findings.' using errcode = '42501';
  end if;

  update public.ai_findings finding
  set
    status = new_status,
    review_note = new_review_note
  where finding.id = target_finding_id
    and finding.organization_id = target_organization_id;

  if not found then
    raise exception 'AI finding is not available for the selected organization.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.review_ai_finding(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_ai_finding(uuid, uuid, text, text)
  to authenticated;

comment on function public.review_ai_finding(uuid, uuid, text, text) is
  'Security-invoker review RPC. RLS authorizes the organization row; a private trigger stamps reviewer provenance.';
