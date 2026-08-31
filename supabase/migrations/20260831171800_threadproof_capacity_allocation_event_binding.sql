-- Bind the exact CapacityVault allocation identifier into the rebuildable allocation read model.
-- The identifier is never recomputed by the application: only a matching canonical
-- CapacityAllocationRecorded event may populate it.

alter table public.capacity_allocations
  add column if not exists chain_allocation_id text;

alter table public.capacity_allocations
  drop constraint if exists capacity_allocations_chain_allocation_id_format;

alter table public.capacity_allocations
  add constraint capacity_allocations_chain_allocation_id_format
  check (
    chain_allocation_id is null
    or chain_allocation_id ~ '^0x[0-9a-fA-F]{64}$'
  );

create unique index if not exists capacity_allocations_chain_allocation_id_key
  on public.capacity_allocations (chain_allocation_id)
  where chain_allocation_id is not null;

create or replace function private.apply_capacity_allocation_recorded_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_allocation_id text;
  event_order_id text;
  event_factory_organization_id text;
  event_state_key text;
  event_nullifier text;
  matched_allocation_id uuid;
begin
  if new.event_name <> 'CapacityAllocationRecorded' then
    return new;
  end if;

  begin
    event_allocation_id := new.data ->> 'allocationId';
    event_order_id := new.data ->> 'orderId';
    event_factory_organization_id := new.data ->> 'factoryOrganizationId';
    event_state_key := new.data ->> 'stateKey';
    event_nullifier := new.data ->> 'nullifier';
  exception when others then
    raise warning 'CapacityAllocationRecorded event % has malformed data; allocation mirror unchanged', new.transaction_hash;
    return new;
  end;

  if event_allocation_id is null or event_allocation_id !~ '^0x[0-9a-fA-F]{64}$'
     or event_order_id is null or event_order_id !~ '^0x[0-9a-fA-F]{64}$'
     or event_factory_organization_id is null or event_factory_organization_id !~ '^0x[0-9a-fA-F]{64}$'
     or event_state_key is null or event_state_key !~ '^0x[0-9a-fA-F]{64}$'
     or event_nullifier is null or event_nullifier !~ '^[0-9]+$'
  then
    raise warning 'CapacityAllocationRecorded event % has invalid allocation/order/factory/state/nullifier metadata; allocation mirror unchanged', new.transaction_hash;
    return new;
  end if;

  begin
    update public.capacity_allocations ca
    set chain_allocation_id = lower(event_allocation_id)
    from public.private_capacity_openings opening,
         public.order_versions ov,
         public.purchase_orders po,
         public.organizations factory
    where ca.capacity_opening_id = opening.id
      and ca.order_version_id = ov.id
      and ov.purchase_order_id = po.id
      and opening.factory_organization_id = factory.id
      and ca.chain_tx_hash = new.transaction_hash
      and ca.nullifier = event_nullifier
      and lower(opening.chain_state_key) = lower(event_state_key)
      and lower(po.chain_order_id) = lower(event_order_id)
      and lower(factory.chain_organization_id) = lower(event_factory_organization_id)
      and (
        ca.chain_allocation_id is null
        or lower(ca.chain_allocation_id) = lower(event_allocation_id)
      )
    returning ca.id into matched_allocation_id;
  exception when unique_violation then
    raise warning 'CapacityAllocationRecorded % conflicts with an existing canonical allocation id; allocation mirror unchanged', event_allocation_id;
    return new;
  end;

  if matched_allocation_id is null then
    raise warning 'CapacityAllocationRecorded % did not match a recovered CapacitySpent allocation; canonical event retained without allocation mirror mutation', event_allocation_id;
  end if;

  return new;
end;
$$;

revoke all on function private.apply_capacity_allocation_recorded_event() from public, anon, authenticated;
grant execute on function private.apply_capacity_allocation_recorded_event() to service_role;

comment on function private.apply_capacity_allocation_recorded_event() is
'Binds CapacityVault CapacityAllocationRecorded allocationId to a previously recovered CapacitySpent allocation only when transaction, nullifier, state, order and factory identity all match.';

drop trigger if exists threadproof_capacity_allocation_event_binding on public.chain_events;
create trigger threadproof_capacity_allocation_event_binding
after insert or update of data, event_name, transaction_hash, block_number, observed_at
on public.chain_events
for each row
execute function private.apply_capacity_allocation_recorded_event();

-- Re-run already indexed allocation events so existing deployments can backfill the new field.
update public.chain_events
set observed_at = observed_at
where event_name = 'CapacityAllocationRecorded';
