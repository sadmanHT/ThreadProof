-- Keep certification lifecycle fields service/indexer-owned. Browser users may only stage or discard unsigned work.
revoke update on public.capacity_certification_jobs from authenticated;
drop policy if exists capacity_certification_auditor_update on public.capacity_certification_jobs;

grant delete on public.capacity_certification_jobs to authenticated;
create policy capacity_certification_auditor_delete_prepared
  on public.capacity_certification_jobs
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and status = 'prepared'
    and credential_tx_hash is null
    and certification_tx_hash is null
    and private.is_organization_member(auditor_organization_id)
  );

comment on column public.capacity_certification_jobs.status is
  'Operational staging lifecycle only. Confirmed state is written by trusted indexing/service paths after matching Besu events and is never canonical shared state.';