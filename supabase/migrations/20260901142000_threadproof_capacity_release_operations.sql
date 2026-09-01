-- Durable operational coordination for cryptographic CapacityRelease transitions.
-- CapacityVault remains canonical. A release is confirmed and private capacity is
-- materialized only after the matching canonical CapacityReleased event is indexed.

create table if not exists public.capacity_release_jobs (
  id uuid primary key default gen_random_uuid(),
  capacity_allocation_id uuid not null references public.capacity_allocations(id) on delete restrict,
  capacity_opening_id uuid not null references public.private_capacity_openings(id) on delete restrict,
  order_version_id uuid not null references public.order_versions(id) on delete restrict,
  chain_allocation_id text not null,
  status text not null default 'queued' check (status in ('queued','generating','generated','submitted','confirmed','failed','stale')),
  release_circuit_version integer not null check (release_circuit_version > 0),
  proof jsonb,
  public_inputs jsonb,
  next_capacity_ciphertext bytea,
  next_randomness_ciphertext bytea,
  chain_tx_hash text,
  chain_block_number bigint,
  worker_claim_token uuid,
  worker_claimed_at timestamptz,
  error_code text,
  error_detail text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capacity_release_jobs_chain_allocation_id_format check (chain_allocation_id ~ '^0x[0-9a-fA-F]{64}$'),
  constraint capacity_release_jobs_chain_tx_hash_format check (chain_tx_hash is null or chain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  unique (capacity_allocation_id),
  unique (chain_allocation_id)
);

create index if not exists capacity_release_jobs_status_created_idx
  on public.capacity_release_jobs(status, created_at);
create index if not exists capacity_release_jobs_claim_idx
  on public.capacity_release_jobs(status, worker_claimed_at)
  where worker_claim_token is not null;
create unique index if not exists capacity_release_jobs_chain_tx_hash_key
  on public.capacity_release_jobs(chain_tx_hash)
  where chain_tx_hash is not null;

alter table public.capacity_release_jobs enable row level security;
revoke all on table public.capacity_release_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.capacity_release_jobs to service_role;

alter table public.capacity_allocations
  add column if not exists release_tx_hash text,
  add column if not exists release_block_number bigint,
  add column if not exists released_at timestamptz,
  add column if not exists release_nullifier text,
  add column if not exists restored_commitment text,
  add column if not exists release_circuit_version integer;

alter table public.capacity_allocations
  drop constraint if exists capacity_allocations_release_tx_hash_format,
  add constraint capacity_allocations_release_tx_hash_format
    check (release_tx_hash is null or release_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists capacity_allocations_release_nullifier_format,
  add constraint capacity_allocations_release_nullifier_format
    check (release_nullifier is null or release_nullifier ~ '^[0-9]+$'),
  drop constraint if exists capacity_allocations_restored_commitment_format,
  add constraint capacity_allocations_restored_commitment_format
    check (restored_commitment is null or restored_commitment ~ '^[0-9]+$'),
  drop constraint if exists capacity_allocations_release_circuit_version_positive,
  add constraint capacity_allocations_release_circuit_version_positive
    check (release_circuit_version is null or release_circuit_version > 0);

create unique index if not exists capacity_allocations_release_tx_hash_key
  on public.capacity_allocations(release_tx_hash)
  where release_tx_hash is not null;

create or replace function private.apply_capacity_released_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_job public.capacity_release_jobs%rowtype;
  allocation public.capacity_allocations%rowtype;
  opening public.private_capacity_openings%rowtype;
  event_allocation_id text;
  event_state_key text;
  event_order_id text;
  release_nullifier text;
  old_commitment text;
  restored_commitment text;
  release_circuit_version integer;
  confirmed_at timestamptz := now();
  mirror_error_code text;
  mirror_error_detail text;
begin
  if new.event_name <> 'CapacityReleased' then
    return new;
  end if;

  begin
    event_allocation_id := new.data ->> 'allocationId';
    event_state_key := new.data ->> 'stateKey';
    event_order_id := new.data ->> 'orderId';
    release_nullifier := new.data ->> 'releaseNullifier';
    old_commitment := new.data ->> 'oldCommitment';
    restored_commitment := new.data ->> 'restoredCommitment';
    release_circuit_version := (new.data ->> 'releaseCircuitVersion')::integer;
  exception when others then
    raise warning 'CapacityReleased event % has malformed data; private mirror unchanged', new.transaction_hash;
    return new;
  end;

  if event_allocation_id is null or event_allocation_id !~ '^0x[0-9a-fA-F]{64}$'
     or event_state_key is null or event_state_key !~ '^0x[0-9a-fA-F]{64}$'
     or event_order_id is null or event_order_id !~ '^0x[0-9a-fA-F]{64}$'
     or release_nullifier is null or release_nullifier !~ '^[0-9]+$'
     or old_commitment is null or old_commitment !~ '^[0-9]+$'
     or restored_commitment is null or restored_commitment !~ '^[0-9]+$'
     or release_circuit_version <= 0
  then
    raise warning 'CapacityReleased event % has invalid identifiers/scalars; private mirror unchanged', new.transaction_hash;
    return new;
  end if;

  select crj.* into matched_job
  from public.capacity_release_jobs crj
  where crj.chain_tx_hash = new.transaction_hash
     or (
       crj.status in ('generated','submitted','confirmed')
       and lower(crj.chain_allocation_id) = lower(event_allocation_id)
       and crj.public_inputs #>> '{signals,8}' = release_nullifier
     )
  order by case when crj.chain_tx_hash = new.transaction_hash then 0 else 1 end, crj.created_at desc
  limit 1;

  if matched_job.id is null then
    raise warning 'CapacityReleased % has no staged release job; canonical event retained without private mirror mutation', new.transaction_hash;
    return new;
  end if;

  if lower(matched_job.chain_allocation_id) <> lower(event_allocation_id)
     or coalesce(matched_job.public_inputs #>> '{signals,5}', '') <> old_commitment
     or coalesce(matched_job.public_inputs #>> '{signals,6}', '') <> restored_commitment
     or coalesce(matched_job.public_inputs #>> '{signals,8}', '') <> release_nullifier
     or lower(coalesce(matched_job.public_inputs #>> '{request,orderId}', '')) <> lower(event_order_id)
     or lower(coalesce(matched_job.public_inputs #>> '{request,stateKey}', '')) <> lower(event_state_key)
     or matched_job.release_circuit_version <> release_circuit_version
  then
    update public.capacity_release_jobs
    set status = 'stale',
        chain_tx_hash = coalesce(chain_tx_hash, new.transaction_hash),
        chain_block_number = new.block_number,
        completed_at = confirmed_at,
        worker_claim_token = null,
        worker_claimed_at = null,
        error_code = 'CHAIN_EVENT_MISMATCH',
        error_detail = 'Indexed CapacityReleased event did not match the staged release proof.'
    where id = matched_job.id;
    raise warning 'CapacityReleased % mismatched release job %; job quarantined as stale', new.transaction_hash, matched_job.id;
    return new;
  end if;

  select ca.* into allocation
  from public.capacity_allocations ca
  where ca.id = matched_job.capacity_allocation_id
  for update;

  if allocation.id is null or lower(coalesce(allocation.chain_allocation_id, '')) <> lower(event_allocation_id) then
    mirror_error_code := 'ALLOCATION_MIRROR_MISSING';
    mirror_error_detail := 'Capacity release is canonical, but the allocation mirror is missing or mismatched.';
  else
    update public.capacity_allocations
    set release_tx_hash = new.transaction_hash,
        release_block_number = new.block_number,
        released_at = confirmed_at,
        release_nullifier = release_nullifier,
        restored_commitment = restored_commitment,
        release_circuit_version = release_circuit_version
    where id = allocation.id;
  end if;

  select pco.* into opening
  from public.private_capacity_openings pco
  where pco.id = matched_job.capacity_opening_id
  for update;

  if opening.id is null then
    mirror_error_code := coalesce(mirror_error_code, 'PRIVATE_OPENING_MISSING');
    mirror_error_detail := coalesce(mirror_error_detail, 'Capacity release is canonical, but the private capacity opening is missing.');
  elsif lower(coalesce(opening.chain_state_key, '')) <> lower(event_state_key) then
    update public.private_capacity_openings
    set status = 'recertification_required',
        last_chain_block = greatest(coalesce(last_chain_block, 0), new.block_number),
        updated_at = confirmed_at
    where id = opening.id;
    mirror_error_code := 'PRIVATE_OPENING_STATE_MISMATCH';
    mirror_error_detail := 'Capacity release state key does not match the private opening; opening quarantined.';
  elsif opening.capacity_commitment = old_commitment then
    if matched_job.next_capacity_ciphertext is not null and matched_job.next_randomness_ciphertext is not null then
      update public.private_capacity_openings
      set capacity_commitment = restored_commitment,
          encrypted_remaining_capacity = matched_job.next_capacity_ciphertext,
          encrypted_randomness = matched_job.next_randomness_ciphertext,
          last_chain_block = new.block_number,
          status = 'active',
          updated_at = confirmed_at
      where id = opening.id and capacity_commitment = old_commitment;
    else
      update public.private_capacity_openings
      set capacity_commitment = restored_commitment,
          last_chain_block = new.block_number,
          status = 'recertification_required',
          updated_at = confirmed_at
      where id = opening.id and capacity_commitment = old_commitment;
      mirror_error_code := 'PRIVATE_RESTORED_STATE_MISSING';
      mirror_error_detail := 'Capacity release is canonical, but the encrypted restored opening is unavailable; opening quarantined.';
    end if;
  elsif opening.capacity_commitment <> restored_commitment then
    update public.private_capacity_openings
    set status = 'recertification_required',
        last_chain_block = greatest(coalesce(last_chain_block, 0), new.block_number),
        updated_at = confirmed_at
    where id = opening.id;
    mirror_error_code := 'PRIVATE_OPENING_DRIFT';
    mirror_error_detail := 'CapacityReleased old/restored commitments do not match the private opening; opening quarantined.';
  end if;

  update public.capacity_release_jobs
  set status = 'confirmed',
      chain_tx_hash = new.transaction_hash,
      chain_block_number = new.block_number,
      completed_at = confirmed_at,
      worker_claim_token = null,
      worker_claimed_at = null,
      next_capacity_ciphertext = null,
      next_randomness_ciphertext = null,
      error_code = mirror_error_code,
      error_detail = mirror_error_detail,
      updated_at = confirmed_at
  where id = matched_job.id;

  return new;
end;
$$;

revoke all on function private.apply_capacity_released_event() from public, anon, authenticated;
grant execute on function private.apply_capacity_released_event() to service_role;

comment on function private.apply_capacity_released_event() is
'Crash-safe reconciliation for canonical CapacityReleased events. Restored private state is applied only after matching chain evidence.';

drop trigger if exists threadproof_capacity_release_event_binding on public.chain_events;
create trigger threadproof_capacity_release_event_binding
after insert or update of data, event_name, transaction_hash, block_number, observed_at
on public.chain_events
for each row
execute function private.apply_capacity_released_event();

-- Re-run any release events indexed before this migration.
update public.chain_events
set observed_at = observed_at
where event_name = 'CapacityReleased';
