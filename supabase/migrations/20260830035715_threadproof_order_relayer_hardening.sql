-- Harden buyer order authorization staging and make application-to-chain order identity immutable.

drop policy if exists order_authorization_jobs_buyer_insert on public.order_authorization_jobs;
drop index if exists public.purchase_orders_chain_order_id_idx;
alter table public.purchase_orders
  drop constraint if exists purchase_orders_chain_order_id_format;
revoke update (chain_order_id) on public.purchase_orders from authenticated;

alter table public.purchase_orders drop column chain_order_id;
alter table public.purchase_orders
  add column chain_order_id text generated always as (
    '0x' || pg_catalog.encode(
      extensions.digest('threadproof:order:' || id::text, 'sha256'),
      'hex'
    )
  ) stored;
alter table public.purchase_orders
  add constraint purchase_orders_chain_order_id_format
    check (chain_order_id ~ '^0x[0-9a-f]{64}$');
create unique index purchase_orders_chain_order_id_idx
  on public.purchase_orders(chain_order_id);

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
  );

alter table public.order_authorization_jobs
  add column worker_claim_token uuid,
  add column worker_claimed_at timestamptz,
  add constraint order_authorization_jobs_signature_format
    check (buyer_signature is null or buyer_signature ~ '^0x[0-9a-fA-F]{130}$'),
  add constraint order_authorization_jobs_tx_hash_format
    check (chain_tx_hash is null or chain_tx_hash ~ '^0x[0-9a-fA-F]{64}$');

create index order_authorization_jobs_claimable_idx
  on public.order_authorization_jobs(status, created_at)
  where worker_claim_token is null and status = 'signed';

comment on column public.purchase_orders.chain_order_id is
  'Deterministic immutable application-to-OrderRegistry bytes32 identifier. Canonical order authorization still comes only from OrderRegistry.';
comment on column public.order_authorization_jobs.worker_claim_token is
  'Service-only crash-safe relayer claim. Does not confer authorization; relayer and OrderRegistry must validate the buyer signature.';
