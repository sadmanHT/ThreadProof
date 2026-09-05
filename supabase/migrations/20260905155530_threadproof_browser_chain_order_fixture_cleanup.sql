create or replace function threadproof_e2e_private.cleanup_browser_chain_order_impl(
  target_order_id uuid,
  target_run_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order public.purchase_orders%rowtype;
  version_count bigint;
  proof_count bigint;
  allocation_count bigint;
  release_count bigint;
  subcontract_count bigint;
  cancellation_count bigint;
  expected_prefix text;
begin
  if target_run_id is null or target_run_id !~ '^[A-Za-z0-9._-]{1,120}$' then
    raise exception 'browser-chain cleanup run id is invalid';
  end if;
  if target_order_id is null then
    raise exception 'browser-chain cleanup order id is required';
  end if;

  expected_prefix := 'E2E-CHAIN-' || target_run_id || '-';

  select * into target_order
  from public.purchase_orders
  where id = target_order_id
  for update;

  if not found then
    return false;
  end if;

  if target_order.external_reference is null
     or left(target_order.external_reference, char_length(expected_prefix)) <> expected_prefix then
    raise exception 'refusing to clean order outside the exact browser-chain run namespace';
  end if;
  if target_order.status not in ('draft', 'proposed') then
    raise exception 'refusing to clean browser-chain order in non-Stage-1 status %', target_order.status;
  end if;
  if target_order.current_version not in (0, 1) then
    raise exception 'refusing to clean browser-chain order with version %', target_order.current_version;
  end if;

  select count(*) into version_count
  from public.order_versions
  where purchase_order_id = target_order_id;
  if version_count > 1 then
    raise exception 'refusing to clean browser-chain order with more than one order version';
  end if;

  select count(*) into proof_count
  from public.proof_jobs pj
  join public.order_versions ov on ov.id = pj.order_version_id
  where ov.purchase_order_id = target_order_id;

  select count(*) into allocation_count
  from public.capacity_allocations ca
  join public.order_versions ov on ov.id = ca.order_version_id
  where ov.purchase_order_id = target_order_id;

  select count(*) into release_count
  from public.capacity_release_jobs crj
  join public.order_versions ov on ov.id = crj.order_version_id
  where ov.purchase_order_id = target_order_id;

  select count(*) into subcontract_count
  from public.subcontract_authorization_jobs saj
  where saj.parent_order_id = target_order_id or saj.child_order_id = target_order_id;

  select count(*) into cancellation_count
  from public.order_cancellation_jobs ocj
  where ocj.purchase_order_id = target_order_id;

  if proof_count <> 0 or allocation_count <> 0 or release_count <> 0
     or subcontract_count <> 0 or cancellation_count <> 0 then
    raise exception 'refusing to clean browser-chain order with downstream protocol state';
  end if;

  delete from public.purchase_orders
  where id = target_order_id
    and external_reference = target_order.external_reference;

  if not found then
    raise exception 'browser-chain order disappeared during cleanup';
  end if;

  return true;
end;
$$;

revoke all on function threadproof_e2e_private.cleanup_browser_chain_order_impl(uuid,text) from public, anon, authenticated;
grant execute on function threadproof_e2e_private.cleanup_browser_chain_order_impl(uuid,text) to service_role;

create or replace function public.cleanup_browser_chain_e2e_order(
  target_order_id uuid,
  target_run_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return threadproof_e2e_private.cleanup_browser_chain_order_impl(
    target_order_id,
    target_run_id
  );
end;
$$;

revoke all on function public.cleanup_browser_chain_e2e_order(uuid,text) from public, anon, authenticated;
grant execute on function public.cleanup_browser_chain_e2e_order(uuid,text) to service_role;

comment on function public.cleanup_browser_chain_e2e_order(uuid,text) is
'Test-only cleanup gate for one exact-run browser-to-chain Stage-1 order fixture. It refuses non-namespaced orders, versions beyond Stage 1, and any order with proof, allocation, release, subcontract, or cancellation state; canonical production state cannot be removed through this function.';
