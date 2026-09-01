-- Human review provenance for non-authoritative AI findings.
-- Review state is operational accountability only and never grants protocol authority.

alter table public.ai_findings
  add column reviewed_by uuid references auth.users(id) on delete restrict,
  add column reviewed_at timestamptz,
  add column review_note text;

alter table public.ai_findings
  add constraint ai_findings_review_note_length
    check (review_note is null or char_length(review_note) <= 2000),
  add constraint ai_findings_review_consistency
    check (
      (status = 'open' and reviewed_by is null and reviewed_at is null and review_note is null)
      or
      (status in ('acknowledged', 'dismissed', 'resolved') and reviewed_by is not null and reviewed_at is not null)
    );

comment on column public.ai_findings.reviewed_by is
'Human reviewer who acknowledged, dismissed, or resolved the advisory AI finding. Reviewer deletion is restricted to preserve audit provenance. This review does not authorize any blockchain action.';
comment on column public.ai_findings.reviewed_at is
'Timestamp of the latest human review-state transition.';
comment on column public.ai_findings.review_note is
'Optional human review rationale. This is operational evidence and never canonical protocol state.';

create index ai_findings_review_status_idx
  on public.ai_findings(organization_id, status, reviewed_at desc);

create index ai_findings_reviewed_by_idx
  on public.ai_findings(reviewed_by)
  where reviewed_by is not null;

create or replace function public.review_ai_finding(
  target_finding_id uuid,
  target_organization_id uuid,
  new_status text,
  new_review_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reviewer_id uuid := auth.uid();
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
    reviewed_by = case when new_status = 'open' then null else reviewer_id end,
    reviewed_at = case when new_status = 'open' then null else now() end,
    review_note = case when new_status = 'open' then null else nullif(btrim(new_review_note), '') end
  where finding.id = target_finding_id
    and finding.organization_id = target_organization_id;

  if not found then
    raise exception 'AI finding is not available for the selected organization.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.review_ai_finding(uuid, uuid, text, text) from public;
revoke all on function public.review_ai_finding(uuid, uuid, text, text) from anon;
grant execute on function public.review_ai_finding(uuid, uuid, text, text) to authenticated;

comment on function public.review_ai_finding(uuid, uuid, text, text) is
'Atomically records non-authoritative AI finding review state after re-checking auth.uid(), active organization membership, and operational role inside Postgres. Does not authorize protocol state.';
