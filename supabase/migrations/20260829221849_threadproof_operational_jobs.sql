-- Operational staging for buyer-signed order authorization and crash-safe proof execution.
-- These rows coordinate transactions but never replace canonical chain state.

alter table public.purchase_orders
  add column chain_order_id text,
  add constraint purchase_orders_chain_order_id_format
    check (chain_order_id is null or chain_order_id ~ '^0x[0-9a-fA-F]{64}$');
create unique index purchase_orders_chain_order_id_idx
  on public.purchase_orders(chain_order_id) where chain_order_id is not null;

grant update (chain_order_id) on public.purchase_orders to authenticated;

alter table public.order_versions
  add column version_hash text,
  add column chain_tx_hash text,
  add column chain_block_number bigint,
  add constraint order_versions_version_hash_format
    check (version_hash is null or version_hash ~ '^0x[0-9a-fA-F]{64}$');
create unique index order_versions_version_hash_idx on public.order_versions(version_hash) where version_hash is not null;
create index order_versions_chain_tx_idx on public.order_versions(chain_tx_hash) where chain_tx_hash is not null;

alter table public.private_capacity_openings
  add column chain_period_id text,
  add column chain_process_id text,
  add constraint capacity_openings_chain_period_id_format check (chain_period_id is null or chain_period_id ~ '^0x[0-9a-fA-F]{64}$'),
  add constraint capacity_openings_chain_process_id_format check (chain_process_id is null or chain_process_id ~ '^0x[0-9a-fA-F]{64}$');

alter table public.proof_jobs add column chain_tx_hash text, add column chain_block_number bigint;
create index proof_jobs_chain_tx_idx on public.proof_jobs(chain_tx_hash) where chain_tx_hash is not null;

create table public.order_authorization_jobs (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  target_version integer not null check (target_version > 0),
  chain_order_id text not null check (chain_order_id ~ '^0x[0-9a-fA-F]{64}$'),
  buyer_organization_id uuid not null references public.organizations(id),
  factory_organization_id uuid not null references public.organizations(id),
  previous_version_hash text not null check (previous_version_hash ~ '^0x[0-9a-fA-F]{64}$'),
  order_commitment numeric(78,0) not null,
  policy_hash text not null check (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  nonce numeric(78,0) not null,
  deadline timestamptz not null,
  confidential_payload_ciphertext bytea not null,
  payload_nonce bytea not null,
  production_period_start date,
  production_period_end date,
  buyer_signature text,
  status text not null default 'prepared' check (status in ('prepared','signed','submitting','submitted','confirmed','failed','stale')),
  chain_tx_hash text,
  chain_block_number bigint,
  error_code text,
  error_detail text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.order_authorization_jobs enable row level security;
grant select on public.order_authorization_jobs to authenticated;
grant insert (
  purchase_order_id, target_version, chain_order_id, buyer_organization_id,
  factory_organization_id, previous_version_hash, order_commitment, policy_hash,
  nonce, deadline, confidential_payload_ciphertext, payload_nonce,
  production_period_start, production_period_end, created_by, status
) on public.order_authorization_jobs to authenticated;
grant update (buyer_signature, status, updated_at) on public.order_authorization_jobs to authenticated;

create policy order_authorization_jobs_buyer_read on public.order_authorization_jobs
  for select to authenticated using (private.is_organization_member(buyer_organization_id));
create policy order_authorization_jobs_buyer_insert on public.order_authorization_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid()) and status = 'prepared' and buyer_signature is null and chain_tx_hash is null
    and exists (
      select 1 from public.purchase_orders po
      join public.organization_members m on m.organization_id = po.buyer_organization_id
      where po.id = order_authorization_jobs.purchase_order_id
        and po.buyer_organization_id = order_authorization_jobs.buyer_organization_id
        and po.factory_organization_id = order_authorization_jobs.factory_organization_id
        and po.chain_order_id = order_authorization_jobs.chain_order_id
        and po.current_version + 1 = order_authorization_jobs.target_version
        and po.status in ('draft','proposed','feasible','infeasible')
        and m.user_id = (select auth.uid()) and m.active
        and m.member_role in ('admin','operator','signer')
    )
  );
create policy order_authorization_jobs_buyer_sign on public.order_authorization_jobs
  for update to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.is_organization_member(buyer_organization_id))
  with check (created_by = (select auth.uid()) and status = 'signed' and buyer_signature is not null and chain_tx_hash is null);

create unique index order_authorization_jobs_active_version_idx
  on public.order_authorization_jobs(purchase_order_id, target_version)
  where status in ('prepared','signed','submitting','submitted');
create index order_authorization_jobs_status_idx on public.order_authorization_jobs(status, created_at);
create index order_authorization_jobs_purchase_order_idx on public.order_authorization_jobs(purchase_order_id, target_version desc);
create index order_authorization_jobs_buyer_idx on public.order_authorization_jobs(buyer_organization_id, created_at desc);
create index order_authorization_jobs_factory_idx on public.order_authorization_jobs(factory_organization_id, created_at desc);
create index order_authorization_jobs_created_by_idx on public.order_authorization_jobs(created_by, created_at desc);

create table public.proof_job_private_state (
  proof_job_id uuid primary key references public.proof_jobs(id) on delete cascade,
  next_capacity_ciphertext bytea not null,
  next_randomness_ciphertext bytea not null,
  created_at timestamptz not null default now()
);
alter table public.proof_job_private_state enable row level security;
create policy proof_job_private_state_no_client_access on public.proof_job_private_state
  for all to authenticated using (false) with check (false);

create or replace function public.queue_capacity_proof(target_order_version_id uuid, target_capacity_opening_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  opening public.private_capacity_openings%rowtype;
  order_factory_id uuid; order_policy_hash text; order_version_number integer; current_version_number integer;
  current_commitment text; version_commitment text; chain_order_identifier text; order_state public.order_status; job_id uuid;
begin
  select * into opening from public.private_capacity_openings c where c.id = target_capacity_opening_id for update;
  if opening.id is null or opening.status <> 'active' then raise exception 'active capacity opening required'; end if;
  if opening.chain_period_id is null or opening.chain_process_id is null then raise exception 'capacity opening is missing canonical period/process identifiers'; end if;
  if not private.is_organization_member(opening.factory_organization_id) then raise exception 'factory membership required'; end if;

  select po.factory_organization_id, ov.policy_hash, ov.version, po.current_version, po.current_order_commitment,
         ov.order_commitment, po.chain_order_id, po.status
  into order_factory_id, order_policy_hash, order_version_number, current_version_number, current_commitment,
       version_commitment, chain_order_identifier, order_state
  from public.order_versions ov join public.purchase_orders po on po.id = ov.purchase_order_id
  where ov.id = target_order_version_id;

  if order_factory_id is null or order_factory_id <> opening.factory_organization_id then raise exception 'order and capacity factory mismatch'; end if;
  if chain_order_identifier is null then raise exception 'order is not anchored to a canonical chain identifier'; end if;
  if current_version_number <> order_version_number or current_commitment <> version_commitment then raise exception 'order version is not current'; end if;
  if order_state not in ('proposed','feasible','infeasible','accepted') then raise exception 'order is not in a proof-eligible state'; end if;
  if order_policy_hash <> opening.policy_hash then raise exception 'order and capacity policy mismatch'; end if;
  if exists (
    select 1 from public.proof_jobs pj
    where pj.order_version_id = target_order_version_id and pj.capacity_opening_id = target_capacity_opening_id
      and pj.status in ('queued','generating','generated','submitted')
  ) then raise exception 'an active proof job already exists'; end if;

  insert into public.proof_jobs (factory_organization_id, order_version_id, capacity_opening_id, status, circuit_version)
  values (opening.factory_organization_id, target_order_version_id, target_capacity_opening_id, 'queued', opening.circuit_version)
  returning id into job_id;
  return job_id;
end;
$$;
