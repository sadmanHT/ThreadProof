-- Harden application RPCs so authenticated callers never bypass RLS.

grant insert (organization_id, email, member_role, token_hash, expires_at, invited_by)
  on public.organization_invitations to authenticated;
grant update (accepted_at) on public.organization_invitations to authenticated;

create policy organization_invitations_admin_insert on public.organization_invitations
  for insert to authenticated
  with check (
    private.is_organization_admin(organization_id)
    and invited_by = (select auth.uid())
    and accepted_at is null
    and expires_at > now()
  );
create policy organization_invitations_recipient_read on public.organization_invitations
  for select to authenticated
  using (lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));
create policy organization_invitations_recipient_update on public.organization_invitations
  for update to authenticated
  using (
    lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
    and accepted_at is null and expires_at > now()
  )
  with check (lower(email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));

grant insert (organization_id, user_id, member_role, active) on public.organization_members to authenticated;
grant update (member_role, active) on public.organization_members to authenticated;
create policy organization_members_invitee_insert on public.organization_members
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1 from public.organization_invitations i
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now()
    )
  );
create policy organization_members_invitee_update on public.organization_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1 from public.organization_invitations i
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now()
    )
  );

grant insert (
  buyer_organization_id, factory_organization_id, external_reference, title,
  product_category, quantity, unit, requested_delivery_date, status, created_by
) on public.purchase_orders to authenticated;
grant update (
  external_reference, title, product_category, quantity, unit, requested_delivery_date, updated_at
) on public.purchase_orders to authenticated;
grant delete on public.purchase_orders to authenticated;

create policy purchase_orders_buyer_draft_insert on public.purchase_orders
  for insert to authenticated
  with check (
    status = 'draft' and current_version = 0
    and current_order_commitment is null and current_policy_hash is null
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.organization_members m
      join public.organizations buyer on buyer.id = m.organization_id
      where m.user_id = (select auth.uid())
        and m.organization_id = purchase_orders.buyer_organization_id
        and m.active and m.member_role in ('admin', 'operator', 'signer')
        and buyer.role = 'buyer' and buyer.status = 'active'
    )
    and exists (
      select 1 from public.organizations factory
      where factory.id = purchase_orders.factory_organization_id
        and factory.role = 'factory' and factory.status = 'active'
    )
  );
create policy purchase_orders_buyer_draft_update on public.purchase_orders
  for update to authenticated
  using (
    status = 'draft'
    and exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid())
        and m.organization_id = purchase_orders.buyer_organization_id
        and m.active and m.member_role in ('admin', 'operator', 'signer')
    )
  )
  with check (
    status = 'draft' and current_version = 0
    and current_order_commitment is null and current_policy_hash is null
  );
create policy purchase_orders_buyer_draft_delete on public.purchase_orders
  for delete to authenticated
  using (
    status = 'draft' and current_version = 0
    and exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid())
        and m.organization_id = purchase_orders.buyer_organization_id
        and m.active and m.member_role in ('admin', 'operator', 'signer')
    )
  );

grant insert (factory_organization_id, order_version_id, capacity_opening_id, status, circuit_version)
  on public.proof_jobs to authenticated;
create policy proof_jobs_factory_queue_insert on public.proof_jobs
  for insert to authenticated
  with check (
    status = 'queued'
    and private.is_organization_member(factory_organization_id)
    and exists (
      select 1 from public.private_capacity_openings c
      where c.id = proof_jobs.capacity_opening_id
        and c.factory_organization_id = proof_jobs.factory_organization_id
        and c.status = 'active' and c.circuit_version = proof_jobs.circuit_version
    )
    and exists (
      select 1 from public.order_versions ov
      join public.purchase_orders po on po.id = ov.purchase_order_id
      where ov.id = proof_jobs.order_version_id
        and po.factory_organization_id = proof_jobs.factory_organization_id
    )
  );

alter function public.create_organization_invitation(uuid,text,text,integer) security invoker;
alter function public.accept_organization_invitation(text) security invoker;
alter function public.create_purchase_order_draft(uuid,uuid,text,text,text,numeric,text,date) security invoker;
alter function public.update_purchase_order_draft(uuid,text,text,text,numeric,text,date) security invoker;
alter function public.delete_purchase_order_draft(uuid) security invoker;
alter function public.queue_capacity_proof(uuid,uuid) security invoker;
