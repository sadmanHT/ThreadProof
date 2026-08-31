-- A canonically confirmed OrderRegistry cancellation is terminal. Keep it in the exclusivity predicate
-- so a version authorization cannot be staged during the brief event-projection interval before
-- purchase_orders.status is updated to cancelled.

create or replace function private.enforce_order_intent_exclusivity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.purchase_order_id::text, 0));

  if tg_table_name = 'order_cancellation_jobs' then
    if exists (
      select 1 from public.order_authorization_jobs a
      where a.purchase_order_id = new.purchase_order_id
        and a.status in ('prepared','signed','submitting','submitted')
    ) then
      raise exception 'order version authorization already in progress';
    end if;
  elsif tg_table_name = 'order_authorization_jobs' then
    if exists (
      select 1 from public.order_cancellation_jobs c
      where c.purchase_order_id = new.purchase_order_id
        and c.status in ('prepared','signed','submitting','submitted','confirmed')
    ) then
      raise exception 'order cancellation already in progress or confirmed';
    end if;
  end if;

  return new;
end;
$$;

drop policy if exists order_authorization_jobs_buyer_insert on public.order_authorization_jobs;
create policy order_authorization_jobs_buyer_insert on public.order_authorization_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status = 'prepared'
    and buyer_signature is null
    and chain_tx_hash is null
    and exists (
      select 1
      from public.purchase_orders po
      join public.organization_members m on m.organization_id = po.buyer_organization_id
      where po.id = order_authorization_jobs.purchase_order_id
        and po.buyer_organization_id = order_authorization_jobs.buyer_organization_id
        and po.factory_organization_id = order_authorization_jobs.factory_organization_id
        and po.chain_order_id = order_authorization_jobs.chain_order_id
        and po.current_version + 1 = order_authorization_jobs.target_version
        and po.status in ('draft','proposed','feasible','infeasible')
        and m.user_id = (select auth.uid())
        and m.active
        and m.member_role in ('admin','operator','signer')
    )
    and not exists (
      select 1 from public.order_cancellation_jobs c
      where c.purchase_order_id = order_authorization_jobs.purchase_order_id
        and c.status in ('prepared','signed','submitting','submitted','confirmed')
    )
  );

comment on function private.enforce_order_intent_exclusivity() is
'Serializes order intents and treats a confirmed OrderRegistry cancellation as terminal, closing the projection interval before purchase_orders becomes cancelled.';
