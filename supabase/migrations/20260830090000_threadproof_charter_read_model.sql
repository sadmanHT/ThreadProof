-- ThreadProof Charter governance read-model projection.
-- Canonical proposal authority remains on ThreadProofCharter. This table is a rebuildable
-- projection of indexed chain events and MUST NOT be used to authorize governance writes.

alter table public.governance_proposal_read_model
  add column if not exists action_hash text,
  add column if not exists metadata_hash text,
  add column if not exists approval_mask integer not null default 0,
  add column if not exists expires_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists executed_at timestamptz;

alter table public.governance_proposal_read_model
  drop constraint if exists governance_proposal_action_hash_format,
  add constraint governance_proposal_action_hash_format
    check (action_hash is null or action_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists governance_proposal_metadata_hash_format,
  add constraint governance_proposal_metadata_hash_format
    check (metadata_hash is null or metadata_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists governance_proposal_approval_mask_range,
  add constraint governance_proposal_approval_mask_range
    check (approval_mask between 0 and 31);

create index if not exists governance_proposal_state_updated_idx
  on public.governance_proposal_read_model(state, updated_at desc);

revoke insert, update, delete, truncate, references, trigger
  on public.governance_proposal_read_model from anon, authenticated;
grant select on public.governance_proposal_read_model to authenticated;
grant select, insert, update on public.governance_proposal_read_model to service_role;

create or replace function private.apply_threadproof_charter_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal_type_label text;
  proposal_id text;
  event_timestamp timestamptz;
begin
  if new.event_name not in (
    'ProposalCreated',
    'ProposalApprovalRecorded',
    'ProposalThresholdReached',
    'ProposalCancelled',
    'ProposalExecuted'
  ) then
    return new;
  end if;

  proposal_id := new.data ->> 'proposalId';
  if proposal_id is null or proposal_id !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid Charter proposal id in indexed event';
  end if;
  event_timestamp := coalesce(new.observed_at, now());

  if new.event_name = 'ProposalCreated' then
    proposal_type_label := case (new.data ->> 'proposalType')::integer
      when 1 then 'organization_suspension'
      when 2 then 'organization_restore'
      when 3 then 'primary_account_rotation'
      when 4 then 'protected_identity_disclosure'
      when 5 then 'charter_policy_update'
      else 'unknown'
    end;

    insert into public.governance_proposal_read_model (
      chain_proposal_id,
      proposal_type,
      proposer_chain_organization_id,
      policy_version,
      approvals_required,
      approvals_received,
      state,
      execute_after,
      executed_tx_hash,
      last_synced_block,
      updated_at,
      action_hash,
      metadata_hash,
      approval_mask,
      expires_at,
      approved_at,
      cancelled_at,
      executed_at
    ) values (
      proposal_id,
      proposal_type_label,
      new.data ->> 'proposerOrganizationId',
      new.data ->> 'policyVersion',
      (new.data ->> 'approvalsRequired')::integer,
      0,
      'pending',
      null,
      null,
      new.block_number,
      event_timestamp,
      new.data ->> 'actionHash',
      new.data ->> 'metadataHash',
      0,
      to_timestamp((new.data ->> 'expiresAt')::double precision),
      null,
      null,
      null
    )
    on conflict (chain_proposal_id) do update set
      proposal_type = excluded.proposal_type,
      proposer_chain_organization_id = excluded.proposer_chain_organization_id,
      policy_version = excluded.policy_version,
      approvals_required = excluded.approvals_required,
      action_hash = excluded.action_hash,
      metadata_hash = excluded.metadata_hash,
      expires_at = excluded.expires_at,
      last_synced_block = greatest(public.governance_proposal_read_model.last_synced_block, excluded.last_synced_block),
      updated_at = excluded.updated_at;

  elsif new.event_name = 'ProposalApprovalRecorded' then
    update public.governance_proposal_read_model
    set approvals_received = (new.data ->> 'approvalsReceived')::integer,
        approvals_required = (new.data ->> 'approvalsRequired')::integer,
        approval_mask = (new.data ->> 'approvalMask')::integer,
        last_synced_block = new.block_number,
        updated_at = event_timestamp
    where chain_proposal_id = proposal_id;

  elsif new.event_name = 'ProposalThresholdReached' then
    update public.governance_proposal_read_model
    set state = 'timelocked',
        approved_at = to_timestamp((new.data ->> 'approvedAt')::double precision),
        execute_after = to_timestamp((new.data ->> 'executeAfter')::double precision),
        last_synced_block = new.block_number,
        updated_at = event_timestamp
    where chain_proposal_id = proposal_id;

  elsif new.event_name = 'ProposalCancelled' then
    update public.governance_proposal_read_model
    set state = 'cancelled',
        cancelled_at = event_timestamp,
        last_synced_block = new.block_number,
        updated_at = event_timestamp
    where chain_proposal_id = proposal_id;

  elsif new.event_name = 'ProposalExecuted' then
    update public.governance_proposal_read_model
    set state = 'executed',
        executed_tx_hash = new.transaction_hash,
        executed_at = event_timestamp,
        last_synced_block = new.block_number,
        updated_at = event_timestamp
    where chain_proposal_id = proposal_id;
  end if;

  return new;
end;
$$;

revoke all on function private.apply_threadproof_charter_event() from public, anon, authenticated;
grant execute on function private.apply_threadproof_charter_event() to service_role;

drop trigger if exists threadproof_charter_event_projection on public.chain_events;
create trigger threadproof_charter_event_projection
  after insert or update of data, event_name, block_number, transaction_hash, observed_at
  on public.chain_events
  for each row
  execute function private.apply_threadproof_charter_event();

comment on table public.governance_proposal_read_model is
'Rebuildable projection of ThreadProofCharter events. Never use this table as authority for proposing, approving, or executing governance actions.';
