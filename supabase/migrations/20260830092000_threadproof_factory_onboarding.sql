-- Canonical factory onboarding bridge.
-- Application requests are private workflow records. Factory identity becomes active only after
-- ThreadProofCharter reaches its auditor+industry threshold and ThreadProofRegistry emits the
-- exact OrganizationRegistered event committed by that proposal.

alter table public.organization_onboarding_requests
  add column if not exists primary_account text,
  add column if not exists wallet_signature text,
  add column if not exists proposed_chain_organization_id text,
  add column if not exists metadata_hash text,
  add column if not exists action_hash text,
  add column if not exists chain_proposal_id text,
  add column if not exists chain_registration_tx_hash text,
  add column if not exists chain_registration_block_number bigint;

alter table public.organization_onboarding_requests
  drop constraint if exists onboarding_primary_account_format,
  add constraint onboarding_primary_account_format
    check (primary_account is null or primary_account ~ '^0x[0-9a-fA-F]{40}$'),
  drop constraint if exists onboarding_wallet_signature_format,
  add constraint onboarding_wallet_signature_format
    check (wallet_signature is null or wallet_signature ~ '^0x[0-9a-fA-F]{130}$'),
  drop constraint if exists onboarding_chain_organization_id_format,
  add constraint onboarding_chain_organization_id_format
    check (proposed_chain_organization_id is null or proposed_chain_organization_id ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists onboarding_metadata_hash_format,
  add constraint onboarding_metadata_hash_format
    check (metadata_hash is null or metadata_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists onboarding_action_hash_format,
  add constraint onboarding_action_hash_format
    check (action_hash is null or action_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists onboarding_chain_proposal_id_format,
  add constraint onboarding_chain_proposal_id_format
    check (chain_proposal_id is null or chain_proposal_id ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists onboarding_registration_tx_hash_format,
  add constraint onboarding_registration_tx_hash_format
    check (chain_registration_tx_hash is null or chain_registration_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  drop constraint if exists onboarding_factory_canonical_fields,
  add constraint onboarding_factory_canonical_fields check (
    requested_role <> 'factory'::public.organization_role or (
      primary_account is not null and
      wallet_signature is not null and
      proposed_chain_organization_id is not null and
      metadata_hash is not null and
      action_hash is not null
    )
  );

create unique index if not exists onboarding_chain_organization_unique_idx
  on public.organization_onboarding_requests(proposed_chain_organization_id)
  where proposed_chain_organization_id is not null;
create unique index if not exists onboarding_action_hash_unique_idx
  on public.organization_onboarding_requests(action_hash)
  where action_hash is not null;
create unique index if not exists onboarding_chain_proposal_unique_idx
  on public.organization_onboarding_requests(chain_proposal_id)
  where chain_proposal_id is not null;

-- Browser clients may read requests permitted by RLS but cannot manufacture canonical onboarding
-- staging fields. The verified Next.js server action performs the insert with service_role only
-- after recovering the proposed primary wallet from its onboarding signature.
revoke insert, update, delete, truncate, references, trigger
  on public.organization_onboarding_requests from anon, authenticated;
grant select on public.organization_onboarding_requests to authenticated;
grant select, insert, update on public.organization_onboarding_requests to service_role;

-- Auditor constituency: Auditor + Independent. Industry constituency: Factory + Industry.
-- These are the same role-to-constituency mappings enforced by ThreadProofCharter.
drop policy if exists onboarding_factory_reviewer_read on public.organization_onboarding_requests;
create policy onboarding_factory_reviewer_read
  on public.organization_onboarding_requests
  for select to authenticated
  using (
    requested_role = 'factory'::public.organization_role
    and exists (
      select 1
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id
      where m.user_id = (select auth.uid())
        and m.active
        and o.status = 'active'::public.organization_status
        and o.role in (
          'factory'::public.organization_role,
          'industry'::public.organization_role,
          'auditor'::public.organization_role,
          'independent'::public.organization_role
        )
    )
  );

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

  if new.event_name <> 'OrganizationRegistered' then
    return new;
  end if;

  select * into request_row
  from public.organization_onboarding_requests r
  where r.requested_role = 'factory'::public.organization_role
    and r.status = 'pending'
    and lower(r.proposed_chain_organization_id) = lower(new.data ->> 'organizationId')
  for update;

  if request_row.id is null then
    return new;
  end if;

  -- Exact event binding. A registry event with different role/account/metadata must never activate
  -- the request, even if its organization id happens to match.
  if (new.data ->> 'role')::integer <> 2
    or lower(new.data ->> 'primaryAccount') <> lower(request_row.primary_account)
    or lower(new.data ->> 'metadataHash') <> lower(request_row.metadata_hash)
  then
    return new;
  end if;

  -- The request must already be linked to a Charter proposal whose indexed approval state proves
  -- both required constituencies (Industry bit 2 + Auditor bit 4) reached the 2-of-2 threshold.
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

  event_timestamp := coalesce(new.observed_at, now());

  insert into public.organizations (
    id,
    chain_organization_id,
    legal_name,
    display_name,
    role,
    status,
    country_code,
    metadata,
    created_at,
    updated_at
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
  set status = 'approved',
      reviewed_at = event_timestamp,
      chain_registration_tx_hash = new.transaction_hash,
      chain_registration_block_number = new.block_number
  where id = request_row.id;

  return new;
end;
$$;

revoke all on function private.apply_threadproof_factory_onboarding_event() from public, anon, authenticated;
grant execute on function private.apply_threadproof_factory_onboarding_event() to service_role;

-- Alphabetically after the generic Charter projection trigger so ProposalCreated type=6 can relabel
-- the row that generic projection just materialized.
drop trigger if exists zz_threadproof_factory_onboarding_projection on public.chain_events;
create trigger zz_threadproof_factory_onboarding_projection
  after insert or update of data, event_name, block_number, transaction_hash, observed_at
  on public.chain_events
  for each row
  execute function private.apply_threadproof_factory_onboarding_event();

comment on column public.organization_onboarding_requests.action_hash is
'Exact ThreadProofCharter FactoryOnboarding action commitment. Application data is not authoritative; activation requires the matching Registry event after Charter threshold.';
