-- ThreadProof application backend layer.
-- This migration adds authenticated UX workflows without making Postgres authoritative
-- for credentials, order authorization, capacity, proof acceptance, or governance.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  job_title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
grant update (display_name, job_title, updated_at) on public.profiles to authenticated;

create or replace function private.is_organization_admin(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = auth.uid()
      and m.organization_id = target_organization_id
      and m.active
      and m.member_role = 'admin'
  );
$$;

create or replace function private.shares_organization_with(target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members mine
    join public.organization_members theirs
      on theirs.organization_id = mine.organization_id and theirs.active
    where mine.user_id = auth.uid() and mine.active and theirs.user_id = target_user_id
  );
$$;

revoke all on function private.is_organization_admin(uuid) from public, anon;
revoke all on function private.shares_organization_with(uuid) from public, anon;
grant execute on function private.is_organization_admin(uuid) to authenticated;
grant execute on function private.shares_organization_with(uuid) to authenticated;

create policy profiles_self_or_peer_read on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_organization_with(id));
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', ''), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists threadproof_auth_user_created on auth.users;
create trigger threadproof_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

insert into public.profiles (id, email, display_name)
select u.id, coalesce(u.email, ''), nullif(coalesce(u.raw_user_meta_data ->> 'display_name', u.raw_user_meta_data ->> 'full_name', ''), '')
from auth.users u
on conflict (id) do nothing;

create table public.organization_onboarding_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  legal_name text not null,
  display_name text not null,
  requested_role public.organization_role not null,
  country_code char(2),
  notes text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.organization_onboarding_requests enable row level security;
grant select, insert on public.organization_onboarding_requests to authenticated;
create policy onboarding_request_self_read on public.organization_onboarding_requests
  for select to authenticated using (requested_by = (select auth.uid()));
create policy onboarding_request_self_insert on public.organization_onboarding_requests
  for insert to authenticated with check (requested_by = (select auth.uid()) and status = 'pending');
create index onboarding_requests_user_idx on public.organization_onboarding_requests(requested_by, created_at desc);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  member_role text not null check (member_role in ('admin', 'operator', 'viewer', 'signer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.organization_invitations enable row level security;
grant select on public.organization_invitations to authenticated;
create policy organization_invitations_admin_read on public.organization_invitations
  for select to authenticated using (private.is_organization_admin(organization_id));
create index organization_invitations_org_idx on public.organization_invitations(organization_id, created_at desc);
create index organization_invitations_email_idx on public.organization_invitations(lower(email), expires_at);

create or replace function public.create_organization_invitation(
  target_organization_id uuid,
  invite_email text,
  invite_member_role text default 'viewer',
  expires_in_hours integer default 72
)
returns table(invitation_id uuid, invite_token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  raw_token text;
  new_id uuid;
  expiry timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not private.is_organization_admin(target_organization_id) then raise exception 'organization admin required'; end if;
  if invite_member_role not in ('admin', 'operator', 'viewer', 'signer') then raise exception 'invalid member role'; end if;
  if expires_in_hours < 1 or expires_in_hours > 720 then raise exception 'expiry must be between 1 and 720 hours'; end if;
  if invite_email is null or position('@' in invite_email) < 2 then raise exception 'valid email required'; end if;
  if not exists (select 1 from public.organizations o where o.id = target_organization_id and o.status = 'active') then
    raise exception 'organization is not active';
  end if;

  raw_token := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  expiry := now() + make_interval(hours => expires_in_hours);
  insert into public.organization_invitations (organization_id, email, member_role, token_hash, expires_at, invited_by)
  values (
    target_organization_id,
    lower(trim(invite_email)),
    invite_member_role,
    pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    expiry,
    auth.uid()
  ) returning id into new_id;
  return query select new_id, raw_token, expiry;
end;
$$;

create or replace function public.accept_organization_invitation(invite_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  invitation public.organization_invitations%rowtype;
  caller_email text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  caller_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if caller_email = '' then raise exception 'authenticated email required'; end if;

  select * into invitation
  from public.organization_invitations i
  where i.token_hash = pg_catalog.encode(extensions.digest(invite_token, 'sha256'), 'hex')
    and i.accepted_at is null and i.expires_at > now()
  for update;

  if invitation.id is null then raise exception 'invitation invalid or expired'; end if;
  if lower(invitation.email) <> caller_email then raise exception 'invitation email does not match authenticated user'; end if;
  if not exists (select 1 from public.organizations o where o.id = invitation.organization_id and o.status = 'active') then
    raise exception 'organization is not active';
  end if;

  insert into public.organization_members (organization_id, user_id, member_role, active)
  values (invitation.organization_id, auth.uid(), invitation.member_role, true)
  on conflict (organization_id, user_id) do update set member_role = excluded.member_role, active = true;
  update public.organization_invitations set accepted_at = now() where id = invitation.id;
  return invitation.organization_id;
end;
$$;

revoke all on function public.create_organization_invitation(uuid,text,text,integer) from public, anon;
revoke all on function public.accept_organization_invitation(text) from public, anon;
grant execute on function public.create_organization_invitation(uuid,text,text,integer) to authenticated;
grant execute on function public.accept_organization_invitation(text) to authenticated;

create policy organization_members_admin_read on public.organization_members
  for select to authenticated using (private.is_organization_admin(organization_id));

alter table public.purchase_orders
  add column factory_organization_id uuid references public.organizations(id),
  add column title text,
  add column product_category text,
  add column quantity numeric(18,3),
  add column unit text,
  add column requested_delivery_date date;
alter table public.purchase_orders
  add constraint purchase_orders_quantity_positive check (quantity is null or quantity > 0);
create index purchase_orders_factory_idx on public.purchase_orders(factory_organization_id, status, updated_at desc);
create index purchase_orders_buyer_status_idx on public.purchase_orders(buyer_organization_id, status, updated_at desc);

create policy purchase_orders_factory_read on public.purchase_orders
  for select to authenticated
  using (factory_organization_id is not null and private.is_organization_member(factory_organization_id));
create policy order_versions_factory_read on public.order_versions
  for select to authenticated
  using (exists (
    select 1 from public.purchase_orders po
    where po.id = order_versions.purchase_order_id
      and po.factory_organization_id is not null
      and private.is_organization_member(po.factory_organization_id)
  ));
create policy proof_jobs_buyer_read on public.proof_jobs
  for select to authenticated
  using (exists (
    select 1 from public.order_versions ov
    join public.purchase_orders po on po.id = ov.purchase_order_id
    where ov.id = proof_jobs.order_version_id
      and private.is_organization_member(po.buyer_organization_id)
  ));
create policy capacity_allocations_buyer_read on public.capacity_allocations
  for select to authenticated
  using (exists (
    select 1 from public.order_versions ov
    join public.purchase_orders po on po.id = ov.purchase_order_id
    where ov.id = capacity_allocations.order_version_id
      and private.is_organization_member(po.buyer_organization_id)
  ));

create or replace function public.create_purchase_order_draft(
  buyer_organization_id uuid,
  factory_organization_id uuid,
  external_reference text,
  title text,
  product_category text,
  quantity numeric,
  unit text,
  requested_delivery_date date default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_order_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if quantity is null or quantity <= 0 then raise exception 'quantity must be positive'; end if;
  if trim(external_reference) = '' or trim(title) = '' or trim(unit) = '' then raise exception 'reference, title and unit are required'; end if;
  if not exists (
    select 1 from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and m.organization_id = buyer_organization_id and m.active
      and m.member_role in ('admin', 'operator', 'signer') and o.role = 'buyer' and o.status = 'active'
  ) then raise exception 'active buyer operator membership required'; end if;
  if not exists (select 1 from public.organizations o where o.id = factory_organization_id and o.role = 'factory' and o.status = 'active') then
    raise exception 'active factory required';
  end if;

  insert into public.purchase_orders (
    buyer_organization_id, factory_organization_id, external_reference, title, product_category,
    quantity, unit, requested_delivery_date, status, created_by
  ) values (
    buyer_organization_id, factory_organization_id, trim(external_reference), trim(title),
    nullif(trim(product_category), ''), quantity, trim(unit), requested_delivery_date, 'draft', auth.uid()
  ) returning id into new_order_id;
  return new_order_id;
end;
$$;

create or replace function public.update_purchase_order_draft(
  target_order_id uuid,
  new_external_reference text,
  new_title text,
  new_product_category text,
  new_quantity numeric,
  new_unit text,
  new_requested_delivery_date date default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare buyer_id uuid;
begin
  select po.buyer_organization_id into buyer_id from public.purchase_orders po
  where po.id = target_order_id and po.status = 'draft' for update;
  if buyer_id is null then raise exception 'draft order not found'; end if;
  if new_quantity is null or new_quantity <= 0 then raise exception 'quantity must be positive'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = buyer_id and m.user_id = auth.uid() and m.active
      and m.member_role in ('admin', 'operator', 'signer')
  ) then raise exception 'buyer operator membership required'; end if;

  update public.purchase_orders
  set external_reference = trim(new_external_reference), title = trim(new_title),
      product_category = nullif(trim(new_product_category), ''), quantity = new_quantity,
      unit = trim(new_unit), requested_delivery_date = new_requested_delivery_date, updated_at = now()
  where id = target_order_id;
end;
$$;

create or replace function public.delete_purchase_order_draft(target_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare buyer_id uuid;
begin
  select po.buyer_organization_id into buyer_id from public.purchase_orders po
  where po.id = target_order_id and po.status = 'draft' for update;
  if buyer_id is null then raise exception 'draft order not found'; end if;
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = buyer_id and m.user_id = auth.uid() and m.active
      and m.member_role in ('admin', 'operator', 'signer')
  ) then raise exception 'buyer operator membership required'; end if;
  delete from public.purchase_orders where id = target_order_id;
end;
$$;

revoke all on function public.create_purchase_order_draft(uuid,uuid,text,text,text,numeric,text,date) from public, anon;
revoke all on function public.update_purchase_order_draft(uuid,text,text,text,numeric,text,date) from public, anon;
revoke all on function public.delete_purchase_order_draft(uuid) from public, anon;
grant execute on function public.create_purchase_order_draft(uuid,uuid,text,text,text,numeric,text,date) to authenticated;
grant execute on function public.update_purchase_order_draft(uuid,text,text,text,numeric,text,date) to authenticated;
grant execute on function public.delete_purchase_order_draft(uuid) to authenticated;

create or replace function public.queue_capacity_proof(target_order_version_id uuid, target_capacity_opening_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  opening public.private_capacity_openings%rowtype;
  order_factory_id uuid;
  job_id uuid;
begin
  select * into opening from public.private_capacity_openings c where c.id = target_capacity_opening_id for update;
  if opening.id is null or opening.status <> 'active' then raise exception 'active capacity opening required'; end if;
  if not private.is_organization_member(opening.factory_organization_id) then raise exception 'factory membership required'; end if;
  select po.factory_organization_id into order_factory_id
  from public.order_versions ov join public.purchase_orders po on po.id = ov.purchase_order_id
  where ov.id = target_order_version_id;
  if order_factory_id is null or order_factory_id <> opening.factory_organization_id then raise exception 'order and capacity factory mismatch'; end if;
  if exists (
    select 1 from public.proof_jobs pj
    where pj.order_version_id = target_order_version_id and pj.capacity_opening_id = target_capacity_opening_id
      and pj.status in ('queued', 'generating', 'generated', 'submitted')
  ) then raise exception 'an active proof job already exists'; end if;
  insert into public.proof_jobs (factory_organization_id, order_version_id, capacity_opening_id, status, circuit_version)
  values (opening.factory_organization_id, target_order_version_id, target_capacity_opening_id, 'queued', opening.circuit_version)
  returning id into job_id;
  return job_id;
end;
$$;

revoke all on function public.queue_capacity_proof(uuid,uuid) from public, anon;
grant execute on function public.queue_capacity_proof(uuid,uuid) to authenticated;
