-- Confirm gasless cancellation jobs only from canonical indexed OrderCancelled events.

create or replace function private.apply_threadproof_order_cancellation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_order_id uuid;
  expected_version integer;
  event_nonce numeric;
  event_timestamp timestamptz;
begin
  if new.event_name <> 'OrderCancelled' then
    return new;
  end if;

  if new.data ->> 'orderId' is null or (new.data ->> 'orderId') !~ '^0x[0-9a-fA-F]{64}$' then
    return new;
  end if;

  select po.id into app_order_id
  from public.purchase_orders po
  where lower(po.chain_order_id) = lower(new.data ->> 'orderId')
  limit 1;
  if app_order_id is null then
    return new;
  end if;

  expected_version := (new.data ->> 'version')::integer;
  event_nonce := (new.data ->> 'nonce')::numeric;
  event_timestamp := coalesce(new.observed_at, now());

  update public.order_cancellation_jobs
  set status = 'confirmed',
      chain_tx_hash = new.transaction_hash,
      chain_block_number = new.block_number,
      worker_claim_token = null,
      worker_claimed_at = null,
      error_code = null,
      error_detail = null,
      updated_at = event_timestamp
  where purchase_order_id = app_order_id
    and expected_version = expected_version
    and nonce = event_nonce
    and status in ('signed','submitting','submitted','confirmed');

  update public.order_authorization_jobs
  set status = 'stale',
      worker_claim_token = null,
      worker_claimed_at = null,
      error_code = 'ORDER_CANCELLED',
      error_detail = 'OrderRegistry cancellation was confirmed before this version authorization executed.',
      updated_at = event_timestamp
  where purchase_order_id = app_order_id
    and status in ('prepared','signed','submitting','submitted');

  return new;
end;
$$;

revoke all on function private.apply_threadproof_order_cancellation_event() from public, anon, authenticated;
grant execute on function private.apply_threadproof_order_cancellation_event() to service_role;

drop trigger if exists threadproof_order_cancellation_event_binding on public.chain_events;
create trigger threadproof_order_cancellation_event_binding
  after insert or update of data, event_name, transaction_hash, block_number, observed_at
  on public.chain_events
  for each row
  execute function private.apply_threadproof_order_cancellation_event();

comment on function private.apply_threadproof_order_cancellation_event() is
'Confirms order_cancellation_jobs and invalidates competing staged order versions only from indexed canonical OrderCancelled events.';
