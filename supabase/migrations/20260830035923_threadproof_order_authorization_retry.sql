-- Allow a buyer operator to discard only their own unsigned prepared authorization so an expired wallet prompt can be retried.
grant delete on public.order_authorization_jobs to authenticated;

create policy order_authorization_jobs_buyer_delete_prepared
  on public.order_authorization_jobs
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and status = 'prepared'
    and private.is_organization_member(buyer_organization_id)
  );
