create index organization_invitations_invited_by_idx
  on public.organization_invitations(invited_by);

-- Replace parallel permissive read policies with one policy per table.
drop policy if exists organization_invitations_admin_read on public.organization_invitations;
drop policy if exists organization_invitations_recipient_read on public.organization_invitations;
create policy organization_invitations_authorized_read on public.organization_invitations
  for select to authenticated
  using (
    private.is_organization_admin(organization_id)
    or lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );

drop policy if exists organization_invitations_recipient_update on public.organization_invitations;
create policy organization_invitations_recipient_update on public.organization_invitations
  for update to authenticated
  using (
    lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    and accepted_at is null and expires_at > now()
  )
  with check (lower(email) = lower(coalesce((select auth.jwt()) ->> 'email', '')));

drop policy if exists organization_members_self_read on public.organization_members;
drop policy if exists organization_members_admin_read on public.organization_members;
create policy organization_members_authorized_read on public.organization_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_organization_admin(organization_id));

drop policy if exists organization_members_invitee_insert on public.organization_members;
create policy organization_members_invitee_insert on public.organization_members
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1 from public.organization_invitations i
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now()
    )
  );

drop policy if exists organization_members_invitee_update on public.organization_members;
create policy organization_members_invitee_update on public.organization_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1 from public.organization_invitations i
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now()
    )
  );

drop policy if exists purchase_orders_buyer_read on public.purchase_orders;
drop policy if exists purchase_orders_factory_read on public.purchase_orders;
create policy purchase_orders_counterparty_read on public.purchase_orders
  for select to authenticated
  using (
    private.is_organization_member(buyer_organization_id)
    or (factory_organization_id is not null and private.is_organization_member(factory_organization_id))
  );

drop policy if exists order_versions_buyer_read on public.order_versions;
drop policy if exists order_versions_factory_read on public.order_versions;
create policy order_versions_counterparty_read on public.order_versions
  for select to authenticated
  using (exists (
    select 1 from public.purchase_orders po
    where po.id = order_versions.purchase_order_id
      and (
        private.is_organization_member(po.buyer_organization_id)
        or (po.factory_organization_id is not null and private.is_organization_member(po.factory_organization_id))
      )
  ));

drop policy if exists proof_jobs_factory_read on public.proof_jobs;
drop policy if exists proof_jobs_buyer_read on public.proof_jobs;
create policy proof_jobs_counterparty_read on public.proof_jobs
  for select to authenticated
  using (
    private.is_organization_member(factory_organization_id)
    or exists (
      select 1 from public.order_versions ov
      join public.purchase_orders po on po.id = ov.purchase_order_id
      where ov.id = proof_jobs.order_version_id
        and private.is_organization_member(po.buyer_organization_id)
    )
  );

drop policy if exists capacity_allocations_factory_read on public.capacity_allocations;
drop policy if exists capacity_allocations_buyer_read on public.capacity_allocations;
create policy capacity_allocations_counterparty_read on public.capacity_allocations
  for select to authenticated
  using (
    exists (
      select 1 from public.private_capacity_openings c
      where c.id = capacity_allocations.capacity_opening_id
        and private.is_organization_member(c.factory_organization_id)
    )
    or exists (
      select 1 from public.order_versions ov
      join public.purchase_orders po on po.id = ov.purchase_order_id
      where ov.id = capacity_allocations.order_version_id
        and private.is_organization_member(po.buyer_organization_id)
    )
  );
