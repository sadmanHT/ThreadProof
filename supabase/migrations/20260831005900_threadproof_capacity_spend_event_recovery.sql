-- Crash-safe reconciliation for confirmed CapacitySpent events.
-- CapacityVault remains canonical. This projection only advances the private operational mirror
-- when the indexed event exactly matches the generated proof job. Missing witness material is
-- quarantined instead of fabricated.

create or replace function private.apply_capacity_spent_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  matched_job public.proof_jobs%rowtype;
  opening public.private_capacity_openings%rowtype;
  private_state public.proof_job_private_state%rowtype;
  old_commitment numeric(78,0);
  new_commitment numeric(78,0);
  order_commitment numeric(78,0);
  spend_nullifier numeric(78,0);
  event_order_id text;
  event_circuit_version integer;
  confirmed_at timestamptz := now();
  mirror_error_code text;
  mirror_error_detail text;
  private_state_consumed boolean := false;
begin
  if new.event_name <> 'CapacitySpent' then
    return new;
  end if;

  begin
    old_commitment := (new.data ->> 'oldCommitment')::numeric;
    new_commitment := (new.data ->> 'newCommitment')::numeric;
    order_commitment := (new.data ->> 'orderCommitment')::numeric;
    spend_nullifier := (new.data ->> 'nullifier')::numeric;
    event_order_id := new.data ->> 'orderId';
    event_circuit_version := (new.data ->> 'circuitVersion')::integer;
  exception when others then
    raise warning 'CapacitySpent event % has malformed indexed data; private mirror unchanged', new.transaction_hash;
    return new;
  end;

  if event_order_id is null or event_order_id !~ '^0x[0-9a-fA-F]{64}$' or event_circuit_version <= 0 then
    raise warning 'CapacitySpent event % has invalid order/circuit metadata; private mirror unchanged', new.transaction_hash;
    return new;
  end if;

  select pj.* into matched_job
  from public.proof_jobs pj
  where pj.chain_tx_hash = new.transaction_hash
     or (
       pj.status in ('generated', 'submitted', 'confirmed')
       and pj.public_inputs #>> '{signals,8}' = spend_nullifier::text
     )
  order by case when pj.chain_tx_hash = new.transaction_hash then 0 else 1 end, pj.created_at desc
  limit 1;

  if matched_job.id is null then
    raise warning 'CapacitySpent % has no staged proof job; canonical event retained without private mirror mutation', new.transaction_hash;
    return new;
  end if;

  begin
    if coalesce((matched_job.public_inputs #>> '{signals,5}')::numeric, -1) <> old_commitment
       or coalesce((matched_job.public_inputs #>> '{signals,6}')::numeric, -1) <> new_commitment
       or coalesce((matched_job.public_inputs #>> '{signals,7}')::numeric, -1) <> order_commitment
       or coalesce((matched_job.public_inputs #>> '{signals,8}')::numeric, -1) <> spend_nullifier
       or lower(coalesce(matched_job.public_inputs #>> '{request,orderId}', '')) <> lower(event_order_id)
       or matched_job.circuit_version <> event_circuit_version
    then
      update public.proof_jobs
      set status = 'stale',
          chain_tx_hash = coalesce(chain_tx_hash, new.transaction_hash),
          chain_block_number = new.block_number,
          completed_at = confirmed_at,
          worker_claim_token = null,
          worker_claimed_at = null,
          error_code = 'CHAIN_EVENT_MISMATCH',
          error_detail = 'Indexed CapacitySpent event did not match the stored proof public inputs or circuit version.'
      where id = matched_job.id;
      raise warning 'CapacitySpent % mismatched proof job %; job quarantined as stale', new.transaction_hash, matched_job.id;
      return new;
    end if;
  exception when others then
    update public.proof_jobs
    set status = 'stale',
        chain_tx_hash = coalesce(chain_tx_hash, new.transaction_hash),
        chain_block_number = new.block_number,
        completed_at = confirmed_at,
        worker_claim_token = null,
        worker_claimed_at = null,
        error_code = 'CHAIN_EVENT_MISMATCH',
        error_detail = 'Stored proof public inputs were malformed during CapacitySpent reconciliation.'
    where id = matched_job.id;
    return new;
  end;

  select * into opening
  from public.private_capacity_openings
  where id = matched_job.capacity_opening_id
  for update;

  if opening.id is null then
    mirror_error_code := 'PRIVATE_OPENING_MISSING';
    mirror_error_detail := 'Capacity spend is canonical, but the linked private capacity opening is missing and must be restored or recertified.';
  else
    select * into private_state
    from public.proof_job_private_state
    where proof_job_id = matched_job.id;

    if opening.capacity_commitment = old_commitment then
      if private_state.proof_job_id is not null then
        update public.private_capacity_openings
        set capacity_commitment = new_commitment,
            encrypted_remaining_capacity = private_state.next_capacity_ciphertext,
            encrypted_randomness = private_state.next_randomness_ciphertext,
            last_chain_block = new.block_number,
            status = 'active',
            updated_at = confirmed_at
        where id = opening.id and capacity_commitment = old_commitment;
        private_state_consumed := true;
      else
        update public.private_capacity_openings
        set capacity_commitment = new_commitment,
            last_chain_block = new.block_number,
            status = 'recertification_required',
            updated_at = confirmed_at
        where id = opening.id and capacity_commitment = old_commitment;
        mirror_error_code := 'PRIVATE_NEXT_STATE_MISSING';
        mirror_error_detail := 'Capacity spend is canonical, but the encrypted next opening is unavailable. The mirror was quarantined for recertification.';
      end if;
    elsif opening.capacity_commitment = new_commitment then
      if private_state.proof_job_id is not null and opening.status = 'recertification_required' then
        update public.private_capacity_openings
        set encrypted_remaining_capacity = private_state.next_capacity_ciphertext,
            encrypted_randomness = private_state.next_randomness_ciphertext,
            last_chain_block = greatest(coalesce(last_chain_block, 0), new.block_number),
            status = 'active',
            updated_at = confirmed_at
        where id = opening.id and capacity_commitment = new_commitment;
        private_state_consumed := true;
      elsif opening.status = 'active' then
        private_state_consumed := private_state.proof_job_id is not null;
      else
        mirror_error_code := 'PRIVATE_OPENING_QUARANTINED';
        mirror_error_detail := 'Canonical capacity commitment is current, but the encrypted private opening remains quarantined.';
      end if;
    else
      update public.private_capacity_openings
      set last_chain_block = greatest(coalesce(last_chain_block, 0), new.block_number),
          status = 'recertification_required',
          updated_at = confirmed_at
      where id = opening.id;
      mirror_error_code := 'PRIVATE_OPENING_DRIFT';
      mirror_error_detail := 'Indexed CapacitySpent old/new commitments do not match the current private mirror; the opening was quarantined without overwriting its commitment.';
    end if;

    insert into public.capacity_allocations (
      capacity_opening_id,
      order_version_id,
      old_commitment,
      new_commitment,
      order_commitment,
      nullifier,
      chain_tx_hash,
      chain_block_number,
      confirmed_at
    ) values (
      matched_job.capacity_opening_id,
      matched_job.order_version_id,
      old_commitment,
      new_commitment,
      order_commitment,
      spend_nullifier,
      new.transaction_hash,
      new.block_number,
      confirmed_at
    ) on conflict do nothing;
  end if;

  update public.proof_jobs
  set status = 'confirmed',
      chain_tx_hash = new.transaction_hash,
      chain_block_number = new.block_number,
      completed_at = confirmed_at,
      worker_claim_token = null,
      worker_claimed_at = null,
      error_code = mirror_error_code,
      error_detail = mirror_error_detail
  where id = matched_job.id;

  if private_state_consumed then
    delete from public.proof_job_private_state where proof_job_id = matched_job.id;
  end if;

  return new;
end;
$$;

revoke all on function private.apply_capacity_spent_event() from public, anon, authenticated;
grant execute on function private.apply_capacity_spent_event() to service_role;

drop trigger if exists capacity_spent_event_reconciliation on public.chain_events;
create trigger capacity_spent_event_reconciliation
  after insert or update of data, event_name, transaction_hash, block_number
  on public.chain_events
  for each row
  execute function private.apply_capacity_spent_event();

comment on function private.apply_capacity_spent_event() is
'Crash-safe private mirror reconciliation for canonical CapacitySpent events. Never fabricates missing witness openings.';

update public.chain_events
set observed_at = observed_at
where event_name = 'CapacitySpent';
