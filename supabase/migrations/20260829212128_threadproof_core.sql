-- ThreadProof private application data model.
-- Shared trust state belongs on the consortium blockchain; this database stores
-- authorized operational data, encrypted openings, workflow state, and read models.

create extension if not exists pgcrypto;

create type public.organization_role as enum (
  'buyer', 'factory', 'auditor', 'regulator', 'industry', 'labor_representative', 'independent'
);

create type public.organization_status as enum ('active', 'suspended', 'revoked');
create type public.credential_status as enum ('active', 'suspended', 'revoked', 'expired');
create type public.order_status as enum ('draft', 'proposed', 'feasible', 'infeasible', 'accepted', 'cancelled', 'completed');
create type public.capacity_state_status as enum ('active', 'pending_spend', 'superseded', 'recertification_required');
create type public.proof_job_status as enum ('queued', 'generating', 'generated', 'submitted', 'confirmed', 'failed', 'stale');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  chain_organization_id text not null unique check (chain_organization_id ~ '^0x[0-9a-fA-F]{64}$'),
  legal_name text not null,
  display_name text not null,
  role public.organization_role not null,
  status public.organization_status not null default 'active',
  country_code char(2),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_role text not null check (member_role in ('admin', 'operator', 'viewer', 'signer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  chain_credential_id text not null unique check (chain_credential_id ~ '^0x[0-9a-fA-F]{64}$'),
  subject_organization_id uuid not null references public.organizations(id),
  issuer_organization_id uuid not null references public.organizations(id),
  credential_type text not null,
  digest text not null check (digest ~ '^0x[0-9a-fA-F]{64}$'),
  scope_hash text not null check (scope_hash ~ '^0x[0-9a-fA-F]{64}$'),
  status public.credential_status not null default 'active',
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  encrypted_credential bytea,
  storage_object_path text,
  chain_tx_hash text,
  created_at timestamptz not null default now(),
  check (valid_until > valid_from)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_organization_id uuid not null references public.organizations(id),
  external_reference text not null,
  status public.order_status not null default 'draft',
  current_version integer not null default 0 check (current_version >= 0),
  current_order_commitment text,
  current_policy_hash text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_organization_id, external_reference)
);

create table public.order_versions (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  version integer not null check (version > 0),
  previous_version_hash text,
  order_commitment text not null check (order_commitment ~ '^0x[0-9a-fA-F]{1,64}$'),
  workload_commitment text check (workload_commitment is null or workload_commitment ~ '^0x[0-9a-fA-F]{1,64}$'),
  policy_hash text not null check (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  confidential_payload_ciphertext bytea not null,
  payload_nonce bytea not null,
  production_period_start date,
  production_period_end date,
  buyer_signature text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (purchase_order_id, version)
);

create table public.private_capacity_openings (
  id uuid primary key default gen_random_uuid(),
  factory_organization_id uuid not null references public.organizations(id),
  capacity_credential_id uuid not null references public.credentials(id),
  period_id text not null,
  process_id text not null,
  chain_state_key text not null unique check (chain_state_key ~ '^0x[0-9a-fA-F]{64}$'),
  capacity_commitment numeric(78,0) not null,
  policy_hash text not null check (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  circuit_version integer not null check (circuit_version > 0),
  encrypted_remaining_capacity bytea not null,
  encrypted_randomness bytea not null,
  encryption_key_version integer not null default 1,
  status public.capacity_state_status not null default 'active',
  last_chain_block bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (factory_organization_id, period_id, process_id)
);

create table public.capacity_allocations (
  id uuid primary key default gen_random_uuid(),
  capacity_opening_id uuid not null references public.private_capacity_openings(id),
  order_version_id uuid not null references public.order_versions(id),
  old_commitment numeric(78,0) not null,
  new_commitment numeric(78,0) not null,
  order_commitment numeric(78,0) not null,
  nullifier numeric(78,0) not null unique,
  chain_tx_hash text unique,
  chain_block_number bigint,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.proof_jobs (
  id uuid primary key default gen_random_uuid(),
  factory_organization_id uuid not null references public.organizations(id),
  order_version_id uuid not null references public.order_versions(id),
  capacity_opening_id uuid not null references public.private_capacity_openings(id),
  status public.proof_job_status not null default 'queued',
  circuit_version integer not null,
  public_inputs jsonb not null default '{}'::jsonb,
  proof jsonb,
  error_code text,
  error_detail text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.encrypted_supplier_identities (
  id uuid primary key default gen_random_uuid(),
  pseudonym text not null unique,
  organization_id uuid not null references public.organizations(id),
  ciphertext bytea not null,
  nonce bytea not null,
  key_version integer not null,
  disclosure_policy_hash text not null check (disclosure_policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at timestamptz not null default now()
);

create table public.governance_proposal_read_model (
  chain_proposal_id text primary key,
  proposal_type text not null,
  proposer_chain_organization_id text not null,
  policy_version text,
  approvals_required integer,
  approvals_received integer not null default 0,
  state text not null,
  execute_after timestamptz,
  executed_tx_hash text,
  last_synced_block bigint not null,
  updated_at timestamptz not null default now()
);

create table public.chain_events (
  id bigserial primary key,
  chain_id bigint not null,
  block_number bigint not null,
  block_hash text not null,
  transaction_hash text not null,
  log_index integer not null,
  contract_address text not null,
  event_name text not null,
  indexed_values jsonb not null default '{}'::jsonb,
  data jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (chain_id, transaction_hash, log_index)
);

create index credentials_subject_idx on public.credentials(subject_organization_id, status);
create index order_versions_po_idx on public.order_versions(purchase_order_id, version desc);
create index capacity_openings_factory_idx on public.private_capacity_openings(factory_organization_id, period_id, process_id);
create index proof_jobs_status_idx on public.proof_jobs(status, created_at);
create index chain_events_block_idx on public.chain_events(chain_id, block_number, log_index);

-- RLS helpers. SECURITY DEFINER functions expose only membership booleans and use a fixed search_path.
create or replace function public.is_consortium_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = auth.uid() and m.active
  );
$$;

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = auth.uid()
      and m.organization_id = target_organization_id
      and m.active
  );
$$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.credentials enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.order_versions enable row level security;
alter table public.private_capacity_openings enable row level security;
alter table public.capacity_allocations enable row level security;
alter table public.proof_jobs enable row level security;
alter table public.encrypted_supplier_identities enable row level security;
alter table public.governance_proposal_read_model enable row level security;
alter table public.chain_events enable row level security;

-- Consortium-visible directory/read models.
create policy organizations_consoritum_read on public.organizations
  for select to authenticated using (public.is_consortium_member());
create policy governance_read on public.governance_proposal_read_model
  for select to authenticated using (public.is_consortium_member());
create policy chain_events_read on public.chain_events
  for select to authenticated using (public.is_consortium_member());

-- Users can see their own organization membership records.
create policy organization_members_self_read on public.organization_members
  for select to authenticated using (user_id = auth.uid());

-- Credential metadata is consortium-visible; encrypted bodies remain unusable without application keys.
create policy credentials_consoritum_read on public.credentials
  for select to authenticated using (public.is_consortium_member());

-- Buyer-private order headers and versions.
create policy purchase_orders_buyer_read on public.purchase_orders
  for select to authenticated using (public.is_organization_member(buyer_organization_id));
create policy order_versions_buyer_read on public.order_versions
  for select to authenticated using (
    exists (
      select 1 from public.purchase_orders po
      where po.id = order_versions.purchase_order_id
        and public.is_organization_member(po.buyer_organization_id)
    )
  );

-- Factory-private capacity witness/opening data.
create policy capacity_openings_factory_read on public.private_capacity_openings
  for select to authenticated using (public.is_organization_member(factory_organization_id));
create policy proof_jobs_factory_read on public.proof_jobs
  for select to authenticated using (public.is_organization_member(factory_organization_id));
create policy capacity_allocations_factory_read on public.capacity_allocations
  for select to authenticated using (
    exists (
      select 1 from public.private_capacity_openings c
      where c.id = capacity_allocations.capacity_opening_id
        and public.is_organization_member(c.factory_organization_id)
    )
  );

-- Protected identity mappings are intentionally service-role only: no authenticated SELECT policy.
-- Mutations for all trust-sensitive tables are likewise service-role / audited API operations only.

comment on table public.private_capacity_openings is
'Encrypted witness openings for the latest blockchain capacity commitments. The database is not authoritative for shared capacity state.';
comment on table public.chain_events is
'Off-chain indexed read model of immutable blockchain events. Never use this table in place of direct chain validation for critical writes.';
