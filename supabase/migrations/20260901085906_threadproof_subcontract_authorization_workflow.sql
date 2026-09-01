-- Operational staging for parent-factory signed subcontract authorization.
-- SubcontractGovernor remains canonical; these rows coordinate preparation, signing,
-- crash-safe relay, and read-model reconciliation only.

create table public.subcontract_authorization_jobs (
  id uuid primary key default gen_random_uuid(),
  parent_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  child_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  parent_chain_order_id text not null check (parent_chain_order_id ~ '^0x[0-9a-fA-F]{64}$'),
  child_chain_order_id text not null check (child_chain_order_id ~ '^0x[0-9a-fA-F]{64}$'),
  buyer_organization_id uuid not null references public.organizations(id) on delete restrict,
  parent_factory_organization_id uuid not null references public.organizations(id) on delete restrict,
  subcontractor_organization_id uuid not null references public.organizations(id) on delete restrict,
  parent_version integer not null check (parent_version > 0),
  child_version integer not null check (child_version > 0),
  parent_version_hash text not null check (parent_version_hash ~ '^0x[0-9a-fA-F]{64}$'),
  child_version_hash text not null check (child_version_hash ~ '^0x[0-9a-fA-F]{64}$'),
  period_id text not null check (period_id ~ '^0x[0-9a-fA-F]{64}$'),
  process_id text not null check (process_id ~ '^0x[0-9a-fA-F]{64}$'),
  policy_hash text not null check (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  compliance_credential_id uuid not null references public.credentials(id) on delete restrict,
  chain_compliance_credential_id text not null check (chain_compliance_credential_id ~ '^0x[0-9a-fA-F]{64}$'),
  process_credential_id uuid not null references public.credentials(id) on delete restrict,
  chain_process_credential_id text not null check (chain_process_credential_id ~ '^0x[0-9a-fA-F]{64}$'),
  capacity_allocation_id uuid not null references public.capacity_allocations(id) on delete restrict,
  chain_capacity_allocation_id text not null check (chain_capacity_allocation_id ~ '^0x[0-9a-fA-F]{64}$'),
  sequence integer not null check (sequence > 0),
  nonce numeric(78,0) not null check (nonce >= 0),
  deadline timestamptz not null,
  parent_factory_signature text check (parent_factory_signature is null or parent_factory_signature ~ '^0x[0-9a-fA-F]{130}$'),
  status text not null default 'prepared' check (status in ('prepared','signed','submitting','submitted','confirmed','failed','stale')),
  chain_tx_hash text check (chain_tx_hash is null or chain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  chain_block_number bigint check (chain_block_number is null or chain_block_number >= 0),
  confirmed_at timestamptz,
  error_code text,
  error_detail text,
  worker_claim_token uuid,
  worker_claimed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_order_id <> child_order_id),
  check (parent_chain_order_id <> child_chain_order_id),
  check (parent_factory_organization_id <> subcontractor_organization_id),
  check (
    (status = 'confirmed' and chain_tx_hash is not null and chain_block_number is not null and confirmed_at is not null)
    or status <> 'confirmed'
  )
);

alter table public.subcontract_authorization_jobs enable row level security;

grant select on public.subcontract_authorization_jobs to authenticated;
grant insert (
  parent_order_id, child_order_id, parent_chain_order_id, child_chain_order_id,
  buyer_organization_id, parent_factory_organization_id, subcontractor_organization_id,
  parent_version, child_version, parent_version_hash, child_version_hash,
  period_id, process_id, policy_hash,
  compliance_credential_id, chain_compliance_credential_id,
  process_credential_id, chain_process_credential_id,
  capacity_allocation_id, chain_capacity_allocation_id,
  sequence, nonce, deadline, created_by, status
) on public.subcontract_authorization_jobs to authenticated;
grant update (parent_factory_signature, status, updated_at) on public.subcontract_authorization_jobs to authenticated;
grant delete on public.subcontract_authorization_jobs to authenticated;
grant select, insert, update, delete on public.subcontract_authorization_jobs to service_role;

create policy subcontract_jobs_counterparty_read on public.subcontract_authorization_jobs
for select to authenticated
using (
  private.is_organization_member(parent_factory_organization_id)
  or private.is_organization_member(subcontractor_organization_id)
  or exists (
    select 1 from public.purchase_orders po
    where po.id = subcontract_authorization_jobs.parent_order_id
      and private.is_organization_member(po.buyer_organization_id)
  )
);

create policy subcontract_jobs_parent_factory_insert on public.subcontract_authorization_jobs
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and status = 'prepared'
  and parent_factory_signature is null
  and chain_tx_hash is null
  and worker_claim_token is null
  and private.is_organization_member(parent_factory_organization_id)
  and exists (
    select 1
    from public.organization_members m
    join public.organizations parent_factory on parent_factory.id = m.organization_id
    join public.organizations subcontractor on subcontractor.id = subcontract_authorization_jobs.subcontractor_organization_id
    where m.user_id = (select auth.uid())
      and m.organization_id = subcontract_authorization_jobs.parent_factory_organization_id
      and m.active
      and m.member_role in ('admin','operator','signer')
      and parent_factory.role = 'factory'
      and parent_factory.status = 'active'
      and subcontractor.role = 'factory'
      and subcontractor.status = 'active'
  )
  and exists (
    select 1
    from public.purchase_orders parent
    join public.purchase_orders child on child.id = subcontract_authorization_jobs.child_order_id
    where parent.id = subcontract_authorization_jobs.parent_order_id
      and parent.chain_order_id = subcontract_authorization_jobs.parent_chain_order_id
      and child.chain_order_id = subcontract_authorization_jobs.child_chain_order_id
      and parent.buyer_organization_id = subcontract_authorization_jobs.buyer_organization_id
      and child.buyer_organization_id = subcontract_authorization_jobs.buyer_organization_id
      and parent.factory_organization_id = subcontract_authorization_jobs.parent_factory_organization_id
      and child.factory_organization_id = subcontract_authorization_jobs.subcontractor_organization_id
      and parent.current_version = subcontract_authorization_jobs.parent_version
      and child.current_version = subcontract_authorization_jobs.child_version
      and parent.current_policy_hash = subcontract_authorization_jobs.policy_hash
      and child.current_policy_hash = subcontract_authorization_jobs.policy_hash
      and parent.status in ('proposed','feasible','infeasible','accepted')
      and child.status in ('proposed','feasible','infeasible','accepted')
  )
  and exists (
    select 1 from public.order_versions ov
    where ov.purchase_order_id = subcontract_authorization_jobs.parent_order_id
      and ov.version = subcontract_authorization_jobs.parent_version
      and ov.version_hash = subcontract_authorization_jobs.parent_version_hash
      and ov.policy_hash = subcontract_authorization_jobs.policy_hash
  )
  and exists (
    select 1 from public.order_versions ov
    where ov.purchase_order_id = subcontract_authorization_jobs.child_order_id
      and ov.version = subcontract_authorization_jobs.child_version
      and ov.version_hash = subcontract_authorization_jobs.child_version_hash
      and ov.policy_hash = subcontract_authorization_jobs.policy_hash
  )
  and exists (
    select 1
    from public.capacity_allocations ca
    join public.order_versions ov on ov.id = ca.order_version_id
    join public.private_capacity_openings opening on opening.id = ca.capacity_opening_id
    where ca.id = subcontract_authorization_jobs.capacity_allocation_id
      and ca.chain_allocation_id = subcontract_authorization_jobs.chain_capacity_allocation_id
      and ca.confirmed_at is not null
      and ov.purchase_order_id = subcontract_authorization_jobs.child_order_id
      and ov.version = subcontract_authorization_jobs.child_version
      and opening.factory_organization_id = subcontract_authorization_jobs.subcontractor_organization_id
      and opening.chain_period_id = subcontract_authorization_jobs.period_id
      and opening.chain_process_id = subcontract_authorization_jobs.process_id
      and opening.policy_hash = subcontract_authorization_jobs.policy_hash
  )
  and exists (
    select 1 from public.credentials c
    where c.id = subcontract_authorization_jobs.compliance_credential_id
      and c.chain_credential_id = subcontract_authorization_jobs.chain_compliance_credential_id
      and c.subject_organization_id = subcontract_authorization_jobs.subcontractor_organization_id
      and c.status = 'active'
      and c.valid_from <= now() and c.valid_until >= now()
  )
  and exists (
    select 1 from public.credentials c
    where c.id = subcontract_authorization_jobs.process_credential_id
      and c.chain_credential_id = subcontract_authorization_jobs.chain_process_credential_id
      and c.subject_organization_id = subcontract_authorization_jobs.subcontractor_organization_id
      and c.status = 'active'
      and c.valid_from <= now() and c.valid_until >= now()
  )
);

create policy subcontract_jobs_parent_factory_sign on public.subcontract_authorization_jobs
for update to authenticated
using (
  created_by = (select auth.uid())
  and status = 'prepared'
  and private.is_organization_member(parent_factory_organization_id)
)
with check (
  created_by = (select auth.uid())
  and status = 'signed'
  and parent_factory_signature is not null
  and chain_tx_hash is null
  and worker_claim_token is null
);

create policy subcontract_jobs_parent_factory_delete_prepared on public.subcontract_authorization_jobs
for delete to authenticated
using (
  created_by = (select auth.uid())
  and status = 'prepared'
  and parent_factory_signature is null
  and chain_tx_hash is null
  and private.is_organization_member(parent_factory_organization_id)
);

create unique index subcontract_jobs_active_child_idx
  on public.subcontract_authorization_jobs(child_order_id)
  where status in ('prepared','signed','submitting','submitted');
create index subcontract_jobs_parent_factory_idx on public.subcontract_authorization_jobs(parent_factory_organization_id, created_at desc);
create index subcontract_jobs_subcontractor_idx on public.subcontract_authorization_jobs(subcontractor_organization_id, created_at desc);
create index subcontract_jobs_buyer_idx on public.subcontract_authorization_jobs(buyer_organization_id, created_at desc);
create index subcontract_jobs_status_idx on public.subcontract_authorization_jobs(status, created_at);
create index subcontract_jobs_chain_tx_idx on public.subcontract_authorization_jobs(chain_tx_hash) where chain_tx_hash is not null;
create index subcontract_jobs_capacity_allocation_idx on public.subcontract_authorization_jobs(capacity_allocation_id);

comment on table public.subcontract_authorization_jobs is
'Operational staging for parent-factory EIP-712 subcontract authorizations. The row coordinates signing/relay only; SubcontractGovernor remains authoritative for parent-child production relationships.';
comment on column public.subcontract_authorization_jobs.parent_factory_signature is
'Parent factory EIP-712 signature over the exact SubcontractGovernor authorization tuple. Buyer consent is inherited from current canonical parent and child OrderRegistry states.';
