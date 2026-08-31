-- Extend the rebuildable Charter proposal read model for privileged protocol actions.
-- Canonical governance authority remains ThreadProofCharter; this trigger only assigns human-readable labels.

create or replace function private.apply_threadproof_charter_proposal_label()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal_id text;
  proposal_type_number integer;
  proposal_type_label text;
begin
  if new.event_name <> 'ProposalCreated' then
    return new;
  end if;

  proposal_id := new.data ->> 'proposalId';
  if proposal_id is null or proposal_id !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid Charter proposal id in indexed event';
  end if;

  proposal_type_number := (new.data ->> 'proposalType')::integer;
  proposal_type_label := case proposal_type_number
    when 1 then 'organization_suspension'
    when 2 then 'organization_restore'
    when 3 then 'primary_account_rotation'
    when 4 then 'protected_identity_disclosure'
    when 5 then 'charter_policy_update'
    when 6 then 'factory_onboarding'
    when 7 then 'protocol_role_update'
    when 8 then 'verifier_registration'
    when 9 then 'subcontract_policy_registration'
    when 10 then 'emergency_pause'
    when 11 then 'emergency_unpause'
    when 12 then 'credential_suspension'
    when 13 then 'credential_restore'
    else 'unknown'
  end;

  update public.governance_proposal_read_model
  set proposal_type = proposal_type_label,
      updated_at = coalesce(new.observed_at, now())
  where chain_proposal_id = proposal_id;

  return new;
end;
$$;

revoke all on function private.apply_threadproof_charter_proposal_label() from public, anon, authenticated;
grant execute on function private.apply_threadproof_charter_proposal_label() to service_role;

drop trigger if exists threadproof_charter_proposal_label_projection on public.chain_events;
create trigger threadproof_charter_proposal_label_projection
  after insert or update of data, event_name, observed_at
  on public.chain_events
  for each row
  execute function private.apply_threadproof_charter_proposal_label();

-- Re-label already indexed ProposalCreated observations without changing proposal authority/state.
update public.governance_proposal_read_model g
set proposal_type = case (e.data ->> 'proposalType')::integer
      when 1 then 'organization_suspension'
      when 2 then 'organization_restore'
      when 3 then 'primary_account_rotation'
      when 4 then 'protected_identity_disclosure'
      when 5 then 'charter_policy_update'
      when 6 then 'factory_onboarding'
      when 7 then 'protocol_role_update'
      when 8 then 'verifier_registration'
      when 9 then 'subcontract_policy_registration'
      when 10 then 'emergency_pause'
      when 11 then 'emergency_unpause'
      when 12 then 'credential_suspension'
      when 13 then 'credential_restore'
      else 'unknown'
    end
from public.chain_events e
where e.event_name = 'ProposalCreated'
  and e.data ->> 'proposalId' = g.chain_proposal_id;

comment on function private.apply_threadproof_charter_proposal_label() is
'Labels rebuildable ThreadProofCharter ProposalCreated events for operator UI. It grants no governance authority and never changes approval or execution state.';