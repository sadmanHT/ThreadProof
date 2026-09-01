-- Keep the live migration history explicit and make the review provenance trigger
-- definition idempotently correct for fresh environments and migration repair flows.
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
