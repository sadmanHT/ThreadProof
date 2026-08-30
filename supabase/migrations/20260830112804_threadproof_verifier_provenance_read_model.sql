-- Rebuildable projection of immutable CapacityVault verifier provenance events.
-- Canonical verifier authority remains on CapacityVault; this table is informational only.

create table public.verifier_provenance_read_model (
  chain_id bigint not null,
  circuit_version integer not null check (circuit_version > 0),
  verifier_address text not null check (verifier_address ~ '^0x[0-9a-fA-F]{40}$'),
  circuit_artifact_hash text not null check (circuit_artifact_hash ~ '^0x[0-9a-fA-F]{64}$'),
  verification_key_hash text not null check (verification_key_hash ~ '^0x[0-9a-fA-F]{64}$'),
  verifier_code_hash text not null check (verifier_code_hash ~ '^0x[0-9a-fA-F]{64}$'),
  registration_tx_hash text not null check (registration_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  contract_address text not null check (contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  registered_block bigint not null check (registered_block >= 0),
  observed_at timestamptz not null,
  primary key (chain_id, circuit_version)
);

create index verifier_provenance_registered_block_idx
  on public.verifier_provenance_read_model(chain_id, registered_block desc);

alter table public.verifier_provenance_read_model enable row level security;

create policy verifier_provenance_consortium_read
  on public.verifier_provenance_read_model
  for select to authenticated
  using (private.is_consortium_member());

revoke all on table public.verifier_provenance_read_model from anon, authenticated;
grant select on table public.verifier_provenance_read_model to authenticated;
grant select, insert, update on table public.verifier_provenance_read_model to service_role;

create or replace function private.apply_verifier_provenance_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_circuit_version integer;
  next_verifier_address text;
  next_circuit_artifact_hash text;
  next_verification_key_hash text;
  next_verifier_code_hash text;
  existing public.verifier_provenance_read_model%rowtype;
begin
  if new.event_name <> 'VerifierProvenanceRegistered' then
    return new;
  end if;

  next_circuit_version := (new.data ->> 'circuitVersion')::integer;
  next_verifier_address := new.data ->> 'verifier';
  next_circuit_artifact_hash := new.data ->> 'circuitArtifactHash';
  next_verification_key_hash := new.data ->> 'verificationKeyHash';
  next_verifier_code_hash := new.data ->> 'verifierCodeHash';

  if next_circuit_version <= 0 then
    raise exception 'invalid verifier circuit version in indexed event';
  end if;
  if next_verifier_address is null or next_verifier_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'invalid verifier address in indexed event';
  end if;
  if next_circuit_artifact_hash is null or next_circuit_artifact_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid circuit artifact hash in indexed event';
  end if;
  if next_verification_key_hash is null or next_verification_key_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid verification key hash in indexed event';
  end if;
  if next_verifier_code_hash is null or next_verifier_code_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid verifier code hash in indexed event';
  end if;

  select * into existing
  from public.verifier_provenance_read_model
  where chain_id = new.chain_id and circuit_version = next_circuit_version;

  if found then
    if lower(existing.verifier_address) <> lower(next_verifier_address)
      or lower(existing.circuit_artifact_hash) <> lower(next_circuit_artifact_hash)
      or lower(existing.verification_key_hash) <> lower(next_verification_key_hash)
      or lower(existing.verifier_code_hash) <> lower(next_verifier_code_hash)
      or lower(existing.registration_tx_hash) <> lower(new.transaction_hash)
      or lower(existing.contract_address) <> lower(new.contract_address)
      or existing.registered_block <> new.block_number
    then
      raise exception 'conflicting verifier provenance for chain %, circuit version %', new.chain_id, next_circuit_version;
    end if;

    update public.verifier_provenance_read_model
    set observed_at = new.observed_at
    where chain_id = new.chain_id and circuit_version = next_circuit_version;
    return new;
  end if;

  insert into public.verifier_provenance_read_model (
    chain_id,
    circuit_version,
    verifier_address,
    circuit_artifact_hash,
    verification_key_hash,
    verifier_code_hash,
    registration_tx_hash,
    contract_address,
    registered_block,
    observed_at
  ) values (
    new.chain_id,
    next_circuit_version,
    next_verifier_address,
    next_circuit_artifact_hash,
    next_verification_key_hash,
    next_verifier_code_hash,
    new.transaction_hash,
    new.contract_address,
    new.block_number,
    new.observed_at
  );

  return new;
end;
$$;

revoke all on function private.apply_verifier_provenance_event() from public, anon, authenticated;
grant execute on function private.apply_verifier_provenance_event() to service_role;

drop trigger if exists verifier_provenance_event_projection on public.chain_events;
create trigger verifier_provenance_event_projection
  after insert or update of data, event_name, chain_id, block_number, transaction_hash, contract_address, observed_at
  on public.chain_events
  for each row
  execute function private.apply_verifier_provenance_event();

comment on table public.verifier_provenance_read_model is
'Rebuildable projection of CapacityVault VerifierProvenanceRegistered events. Never use this table as authority for verifier registration or proof acceptance.';
