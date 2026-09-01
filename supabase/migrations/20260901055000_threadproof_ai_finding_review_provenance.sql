-- Human review provenance for non-authoritative AI findings.
-- Review state is operational accountability only and never grants protocol authority.

alter table public.ai_findings
  add column reviewed_by uuid references auth.users(id) on delete set null,
  add column reviewed_at timestamptz,
  add column review_note text;

alter table public.ai_findings
  add constraint ai_findings_review_note_length
    check (review_note is null or char_length(review_note) <= 2000),
  add constraint ai_findings_review_consistency
    check (
      (status = 'open' and reviewed_by is null and reviewed_at is null)
      or
      (status in ('acknowledged', 'dismissed', 'resolved') and reviewed_by is not null and reviewed_at is not null)
    );

comment on column public.ai_findings.reviewed_by is
'Human reviewer who acknowledged, dismissed, or resolved the advisory AI finding. This review does not authorize any blockchain action.';
comment on column public.ai_findings.reviewed_at is
'Timestamp of the latest human review-state transition.';
comment on column public.ai_findings.review_note is
'Optional human review rationale. This is operational evidence and never canonical protocol state.';

create index ai_findings_review_status_idx
  on public.ai_findings(organization_id, status, reviewed_at desc);

create index ai_findings_reviewed_by_idx
  on public.ai_findings(reviewed_by)
  where reviewed_by is not null;
