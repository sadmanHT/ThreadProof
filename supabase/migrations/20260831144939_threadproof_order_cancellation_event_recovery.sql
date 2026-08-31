-- Canonical OrderCancelled evidence may recover a cancellation job that was marked stale/failed
-- after a relayer crash or delayed indexer observation.
create or replace function private.apply_threadproof_order_cancellation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_order_id uuid;
  cancelled_version integer;
  event_nonce text;
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

  cancelled_version := (new.data ->> 'version')::integer;
  event_nonce := new.data ->> 'nonce';
  if event_nonce is null or event_nonce !~ '^[0-9]+$' then
    return new;
  end if;
  event_timestamp := coalesce(new.observed_at, now());

  update public.order_cancellation_jobs c
  set status = 'confirmed',
      chain_tx_hash = new.transaction_hash,
      chain_block_number = new.block_number,
      worker_claim_token = null,
      worker_claimed_at = null,
      error_code = null,
      error_detail = null,
      updated_at = event_timestamp
  where c.purchase_order_id = app_order_id
    and c.expected_version = cancelled_version
    and c.nonce = event_nonce
    and c.status in ('signed','submitting','submitted','failed','stale','confirmed');

  update public.order_authorization_jobs a
  set status = 'stale',
      worker_claim_token = null,
      worker_claimed_at = null,
      error_code = 'ORDER_CANCELLED',
      error_detail = 'OrderRegistry cancellation was confirmed before this version authorization executed.',
      updated_at = event_timestamp
  where a.purchase_order_id = app_order_id
    and a.status in ('prepared','signed','submitting','submitted');

  return new;
end;
$$;

comment on function private.apply_threadproof_order_cancellation_event() is
'Reconciles exact version/nonce OrderCancelled evidence into cancellation jobs, including crash-recovery from stale/failed worker states, and invalidates competing order-version intents.';
