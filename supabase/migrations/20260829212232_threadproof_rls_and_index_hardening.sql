-- Harden ThreadProof RLS helpers and add indexes for foreign-key/RLS lookups.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

alter function public.is_consortium_member() set schema private;
alter function public.is_organization_member(uuid) set schema private;

alter function private.is_consortium_member() set search_path = '';
alter function private.is_organization_member(uuid) set search_path = '';

revoke all on function private.is_consortium_member() from public;
revoke all on function private.is_organization_member(uuid) from public;
grant execute on function private.is_consortium_member() to authenticated;
grant execute on function private.is_organization_member(uuid) to authenticated;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

alter policy organization_members_self_read on public.organization_members
  using (user_id = (select auth.uid()));

create index if not exists organization_members_user_idx
  on public.organization_members(user_id);
create index if not exists credentials_issuer_idx
  on public.credentials(issuer_organization_id, status);
create index if not exists purchase_orders_created_by_idx
  on public.purchase_orders(created_by);
create index if not exists order_versions_created_by_idx
  on public.order_versions(created_by);
create index if not exists capacity_openings_credential_idx
  on public.private_capacity_openings(capacity_credential_id);
create index if not exists capacity_allocations_opening_idx
  on public.capacity_allocations(capacity_opening_id);
create index if not exists capacity_allocations_order_version_idx
  on public.capacity_allocations(order_version_id);
create index if not exists proof_jobs_factory_idx
  on public.proof_jobs(factory_organization_id);
create index if not exists proof_jobs_order_version_idx
  on public.proof_jobs(order_version_id);
create index if not exists proof_jobs_capacity_opening_idx
  on public.proof_jobs(capacity_opening_id);
create index if not exists encrypted_supplier_identities_org_idx
  on public.encrypted_supplier_identities(organization_id);
