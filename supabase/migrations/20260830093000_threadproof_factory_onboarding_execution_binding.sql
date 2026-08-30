-- Bind application activation to the Charter execution event, not merely a threshold-qualified
-- Registry event. This remains correct even in development environments where a deployer may
-- temporarily retain REGISTRAR_ROLE: direct registrar calls cannot materialize membership.

create or replace function private.apply_threadproof_factory_onboarding_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal_id text;
  request_row public.organization_onboarding_requests%rowtype;
  app_organization_id uuid;
  event_timestamp timestamptz;
begin
  if new.event_name = 'ProposalCreated' and (new.data ->> 'proposalType') = '6' then
    proposal_id := new.data ->> 'proposalId';
    if proposal_id is null or proposal_id !~ '^0x[0-9a-fA-F]{64}$' then
      return new;
    end if;

    update public.governance_proposal_read_model
    set proposal_type = 'factory_onboarding', updated_at = coalesce(new.observed_at, now())
    where chain_proposal_id = proposal_id;

    update public.organization_onboarding_requests
    set chain_proposal_id = proposal_id
    where requested_role = 'factory'::public.organization_role
      and status = 'pending'
      and chain_proposal_id is null
      and action_hash = new.data ->> 'actionHash'
      and metadata_hash = new.data ->> 'metadataHash';

    return new;
  end if;

  if new.event_name = 'OrganizationRegistered' then
    select * into request_row
    from public.organization_onboarding_requests r
    where r.requested_role = 'factory'::public.organization_role
      and r.status = 'pending'
      and lower(r.proposed_chain_organization_id) = lower(new.data ->> 'organizationId')
    for update;

    if request_row.id is null then return new; end if;
    if (new.data ->> 'role')::integer <> 2
      or lower(new.data ->> 'primaryAccount') <> lower(request_row.primary_account)
      or lower(new.data ->> 'metadataHash') <> lower(request_row.metadata_hash)
    then
      return new;
    end if;

    if request_row.chain_proposal_id is null or not exists (
      select 1
      from public.governance_proposal_read_model g
      where g.chain_proposal_id = request_row.chain_proposal_id
        and g.proposal_type = 'factory_onboarding'
        and lower(g.action_hash) = lower(request_row.action_hash)
        and g.approvals_received >= 2
        and g.approvals_required = 2
        and (g.approval_mask & 6) = 6
        and g.approved_at is not null
    ) then
      return new;
    end if;

    -- Stage only the exact canonical Registry receipt. Membership is still withheld until the
    -- matching ProposalExecuted(type=6) event from this same transaction is indexed.
    update public.organization_onboarding_requests
    set chain_registration_tx_hash = new.transaction_hash,
        chain_registration_block_number = new.block_number
    where id = request_row.id;
    return new;
  end if;

  if new.event_name <> 'ProposalExecuted' or (new.data ->> 'proposalType') <> '6' then
    return new;
  end if;

  proposal_id := new.data ->> 'proposalId';
  select * into request_row
  from public.organization_onboarding_requests r
  where r.requested_role = 'factory'::public.organization_role
    and r.status = 'pending'
    and r.chain_proposal_id = proposal_id
    and r.chain_registration_tx_hash = new.transaction_hash
  for update;

  if request_row.id is null then return new; end if;

  if not exists (
    select 1
    from public.governance_proposal_read_model g
    where g.chain_proposal_id = proposal_id
      and g.proposal_type = 'factory_onboarding'
      and g.state = 'executed'
      and g.executed_tx_hash = new.transaction_hash
      and lower(g.action_hash) = lower(request_row.action_hash)
      and g.approvals_received >= 2
      and g.approvals_required = 2
      and (g.approval_mask & 6) = 6
      and g.approved_at is not null
  ) then
    return new;
  end if;

  if not exists (
    select 1
    from public.chain_events e
    where e.chain_id = new.chain_id
      and e.transaction_hash = new.transaction_hash
      and e.event_name = 'OrganizationRegistered'
      and lower(e.data ->> 'organizationId') = lower(request_row.proposed_chain_organization_id)
      and lower(e.data ->> 'primaryAccount') = lower(request_row.primary_account)
      and (e.data ->> 'role')::integer = 2
      and lower(e.data ->> 'metadataHash') = lower(request_row.metadata_hash)
  ) then
    return new;
  end if;

  event_timestamp := coalesce(new.observed_at, now());

  insert into public.organizations (
    id, chain_organization_id, legal_name, display_name, role, status,
    country_code, metadata, created_at, updated_at
  ) values (
    request_row.id,
    request_row.proposed_chain_organization_id,
    request_row.legal_name,
    request_row.display_name,
    'factory'::public.organization_role,
    'active'::public.organization_status,
    request_row.country_code,
    jsonb_build_object(
      'onboarding_request_id', request_row.id,
      'metadata_hash', request_row.metadata_hash,
      'primary_account', request_row.primary_account,
      'charter_proposal_id', request_row.chain_proposal_id
    ),
    event_timestamp,
    event_timestamp
  )
  on conflict (chain_organization_id) do update set
    status = 'active'::public.organization_status,
    updated_at = excluded.updated_at
  returning id into app_organization_id;

  insert into public.organization_members (organization_id, user_id, member_role, active)
  values (app_organization_id, request_row.requested_by, 'admin', true)
  on conflict (organization_id, user_id) do update
    set member_role = 'admin', active = true;

  update public.organization_onboarding_requests
  set status = 'approved', reviewed_at = event_timestamp
  where id = request_row.id;

  return new;
end;
$$;

revoke all on function private.apply_threadproof_factory_onboarding_event() from public, anon, authenticated;
grant execute on function private.apply_threadproof_factory_onboarding_event() to service_role;

comment on function private.apply_threadproof_factory_onboarding_event() is
'Projects signed factory onboarding from chain events. Application activation requires a matching Registry registration and Charter ProposalExecuted(type=6) in the same transaction.';
