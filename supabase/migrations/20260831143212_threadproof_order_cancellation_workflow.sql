-- Buyer-signed OrderRegistry cancellation staging. Canonical order state remains on-chain.

create table public.order_cancellation_jobs (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  chain_order_id text not null check (chain_order_id ~ '^0x[0-9a-fA-F]{64}$'),
  buyer_organization_id uuid not null references public.organizations(id),
  expected_version integer not null check (expected_version > 0),
  nonce numeric(78,0) not null,
  deadline timestamptz not null,
  buyer_signature text,
  status text not null default 'prepared' check (status in ('prepared','signed','submitting','submitted','confirmed','failed','stale')),
  chain_tx_hash text,
  chain_block_number bigint,
  worker_claim_token uuid,
  worker_claimed_at timestamptz,
  error_code text,
  error_detail text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_cancellation_jobs_signature_format
    check (buyer_signature is null or buyer_signature ~ '^0x[0-9a-fA-F]{130}$'),
  constraint order_cancellation_jobs_tx_hash_format
    check (chain_tx_hash is null or chain_tx_hash ~ '^0x[0-9a-fA-F]{64}$')
);

alter table public.order_cancellation_jobs enable row level security;
revoke all on public.order_cancellation_jobs from anon;
grant select on public.order_cancellation_jobs to authenticated;
grant insert (
  purchase_order_id, chain_order_id, buyer_organization_id, expected_version,
  nonce, deadline, created_by, status
) on public.order_cancellation_jobs to authenticated;
grant update (buyer_signature, status, updated_at) on public.order_cancellation_jobs to authenticated;
grant delete on public.order_cancellation_jobs to authenticated;
grant select, insert, update, delete on public.order_cancellation_jobs to service_role;

create policy order_cancellation_jobs_buyer_read on public.order_cancellation_jobs
  for select to authenticated
  using (private.is_organization_member(buyer_organization_id));

create policy order_cancellation_jobs_buyer_insert on public.order_cancellation_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status = 'prepared'
    and buyer_signature is null
    and chain_tx_hash is null
    and exists (
      select 1
      from public.purchase_orders po
      join public.organizations buyer on buyer.id = po.buyer_organization_id
      join public.organization_members m on m.organization_id = po.buyer_organization_id
      where po.id = order_cancellation_jobs.purchase_order_id
        and po.buyer_organization_id = order_cancellation_jobs.buyer_organization_id
        and po.chain_order_id = order_cancellation_jobs.chain_order_id
        and po.current_version = order_cancellation_jobs.expected_version
        and po.current_version > 0
        and po.status in ('proposed','feasible','infeasible','accepted')
        and buyer.role = 'buyer'
        and buyer.status = 'active'
        and m.user_id = (select auth.uid())
        and m.active
        and m.member_role in ('admin','operator','signer')
    )
    and not exists (
      select 1 from public.order_authorization_jobs a
      where a.purchase_order_id = order_cancellation_jobs.purchase_order_id
        and a.status in ('prepared','signed','submitting','submitted')
    )
  );

create policy order_cancellation_jobs_buyer_sign on public.order_cancellation_jobs
  for update to authenticated
  using (
    created_by = (select auth.uid())
    and status = 'prepared'
    and private.is_organization_member(buyer_organization_id)
  )
  with check (
    created_by = (select auth.uid())
    and status = 'signed'
    and buyer_signature is not null
    and chain_tx_hash is null
  );

create policy order_cancellation_jobs_buyer_delete_prepared on public.order_cancellation_jobs
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and status = 'prepared'
    and private.is_organization_member(buyer_organization_id)
  );

create unique index order_cancellation_jobs_active_order_idx
  on public.order_cancellation_jobs(purchase_order_id)
  where status in ('prepared','signed','submitting','submitted');
create index order_cancellation_jobs_claimable_idx
  on public.order_cancellation_jobs(status, created_at)
  where worker_claim_token is null and status = 'signed';
create index order_cancellation_jobs_buyer_idx
  on public.order_cancellation_jobs(buyer_organization_id, created_at desc);

-- Serialize creation of mutually exclusive order intents across the two staging tables.
create or replace function private.enforce_order_intent_exclusivity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.purchase_order_id::text, 0));

  if tg_table_name = 'order_cancellation_jobs' then
    if exists (
      select 1 from public.order_authorization_jobs a
      where a.purchase_order_id = new.purchase_order_id
        and a.status in ('prepared','signed','submitting','submitted')
    ) then
      raise exception 'order version authorization already in progress';
    end if;
  elsif tg_table_name = 'order_authorization_jobs' then
    if exists (
      select 1 from public.order_cancellation_jobs c
      where c.purchase_order_id = new.purchase_order_id
        and c.status in ('prepared','signed','submitting','submitted')
    ) then
      raise exception 'order cancellation already in progress';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_order_intent_exclusivity() from public, anon, authenticated;
grant execute on function private.enforce_order_intent_exclusivity() to service_role;

drop trigger if exists order_cancellation_intent_exclusivity on public.order_cancellation_jobs;
create trigger order_cancellation_intent_exclusivity
  before insert on public.order_cancellation_jobs
  for each row execute function private.enforce_order_intent_exclusivity();

drop trigger if exists order_authorization_intent_exclusivity on public.order_authorization_jobs;
create trigger order_authorization_intent_exclusivity
  before insert on public.order_authorization_jobs
  for each row execute function private.enforce_order_intent_exclusivity();

-- Defense in depth for direct authenticated inserts into the existing authorization table.
drop policy if exists order_authorization_jobs_buyer_insert on public.order_authorization_jobs;
create policy order_authorization_jobs_buyer_insert on public.order_authorization_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and status = 'prepared'
    and buyer_signature is null
    and chain_tx_hash is null
    and exists (
      select 1
      from public.purchase_orders po
      join public.organization_members m on m.organization_id = po.buyer_organization_id
      where po.id = order_authorization_jobs.purchase_order_id
        and po.buyer_organization_id = order_authorization_jobs.buyer_organization_id
        and po.factory_organization_id = order_authorization_jobs.factory_organization_id
        and po.chain_order_id = order_authorization_jobs.chain_order_id
        and po.current_version + 1 = order_authorization_jobs.target_version
        and po.status in ('draft','proposed','feasible','infeasible')
        and m.user_id = (select auth.uid())
        and m.active
        and m.member_role in ('admin','operator','signer')
    )
    and not exists (
      select 1 from public.order_cancellation_jobs c
      where c.purchase_order_id = order_authorization_jobs.purchase_order_id
        and c.status in ('prepared','signed','submitting','submitted')
    )
  );

comment on table public.order_cancellation_jobs is
'Gasless buyer-signed OrderRegistry cancellation staging. Rows coordinate signatures/relay only; OrderRegistry remains canonical.';
comment on function private.enforce_order_intent_exclusivity() is
'Serializes mutually exclusive order-version and cancellation intents so the shared buyer nonce cannot be staged concurrently.';
