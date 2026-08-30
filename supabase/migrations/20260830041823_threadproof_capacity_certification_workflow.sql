-- Auditor capacity-certification staging. Exact capacity and opening randomness are encrypted.
-- Only CredentialRegistry/CapacityVault events may promote these jobs into canonical read models.

create table public.capacity_certification_jobs (
  id uuid primary key default gen_random_uuid(),
  factory_organization_id uuid not null references public.organizations(id),
  auditor_organization_id uuid not null references public.organizations(id),
  chain_credential_id text not null unique
    check (chain_credential_id ~ '^0x[0-9a-fA-F]{64}$'),
  chain_period_id text not null
    check (chain_period_id ~ '^0x[0-9a-fA-F]{64}$'),
  chain_process_id text not null
    check (chain_process_id ~ '^0x[0-9a-fA-F]{64}$'),
  period_label text not null,
  process_label text not null,
  policy_hash text not null
    check (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  capacity_commitment text not null
    check (capacity_commitment ~ '^[0-9]+$'),
  credential_scope_hash text not null
    check (credential_scope_hash ~ '^0x[0-9a-fA-F]{64}$'),
  credential_digest text not null
    check (credential_digest ~ '^0x[0-9a-fA-F]{64}$'),
  assessment_methodology text not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  circuit_version integer not null check (circuit_version > 0),
  encrypted_capacity bytea not null,
  encrypted_randomness bytea not null,
  encryption_key_version integer not null default 1 check (encryption_key_version > 0),
  status text not null default 'prepared'
    check (status in ('prepared','credential_submitted','credential_confirmed','certification_submitted','confirmed','failed','stale')),
  credential_tx_hash text,
  credential_block_number bigint,
  certification_tx_hash text,
  certification_block_number bigint,
  error_code text,
  error_detail text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capacity_certification_validity_window check (valid_until > valid_from),
  constraint capacity_certification_credential_tx_format check (credential_tx_hash is null or credential_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint capacity_certification_tx_format check (certification_tx_hash is null or certification_tx_hash ~ '^0x[0-9a-fA-F]{64}$')
);

alter table public.capacity_certification_jobs enable row level security;

grant select on public.capacity_certification_jobs to authenticated;
grant insert (
  factory_organization_id,
  auditor_organization_id,
  chain_credential_id,
  chain_period_id,
  chain_process_id,
  period_label,
  process_label,
  policy_hash,
  capacity_commitment,
  credential_scope_hash,
  credential_digest,
  assessment_methodology,
  valid_from,
  valid_until,
  circuit_version,
  encrypted_capacity,
  encrypted_randomness,
  encryption_key_version,
  status,
  created_by
) on public.capacity_certification_jobs to authenticated;
grant update (
  status,
  credential_tx_hash,
  certification_tx_hash,
  error_code,
  error_detail,
  updated_at
) on public.capacity_certification_jobs to authenticated;

create policy capacity_certification_auditor_read
  on public.capacity_certification_jobs
  for select to authenticated
  using (private.is_organization_member(auditor_organization_id));

create policy capacity_certification_auditor_insert
  on public.capacity_certification_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status = 'prepared'
    and credential_tx_hash is null
    and certification_tx_hash is null
    and exists (
      select 1
      from public.organization_members m
      join public.organizations auditor on auditor.id = m.organization_id
      where m.user_id = (select auth.uid())
        and m.organization_id = capacity_certification_jobs.auditor_organization_id
        and m.active
        and m.member_role in ('admin','operator','signer')
        and auditor.role = 'auditor'
        and auditor.status = 'active'
    )
    and exists (
      select 1
      from public.organizations factory
      where factory.id = capacity_certification_jobs.factory_organization_id
        and factory.role = 'factory'
        and factory.status = 'active'
    )
  );

create policy capacity_certification_auditor_update
  on public.capacity_certification_jobs
  for update to authenticated
  using (
    created_by = (select auth.uid())
    and private.is_organization_member(auditor_organization_id)
  )
  with check (
    created_by = (select auth.uid())
    and private.is_organization_member(auditor_organization_id)
  );

create index capacity_certification_jobs_auditor_idx
  on public.capacity_certification_jobs(auditor_organization_id, created_at desc);
create index capacity_certification_jobs_factory_idx
  on public.capacity_certification_jobs(factory_organization_id, created_at desc);
create index capacity_certification_jobs_status_idx
  on public.capacity_certification_jobs(status, created_at);
create unique index capacity_certification_jobs_active_scope_idx
  on public.capacity_certification_jobs(factory_organization_id, chain_period_id, chain_process_id)
  where status not in ('failed','stale');

comment on table public.capacity_certification_jobs is
  'Private auditor workflow staging. Exact capacity is encrypted; canonical credential/capacity state is determined only by Besu events.';