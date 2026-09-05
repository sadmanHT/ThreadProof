-- Harden authenticated browser mutations without granting browser sessions authority over
-- canonical/private service-owned state. Reads remain available to ordinary organization
-- viewers where existing RLS permits them; mutations require an active operational role.

create or replace function private.has_operational_membership(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = auth.uid()
      and m.organization_id = target_organization_id
      and m.active
      and m.member_role in ('admin', 'operator', 'signer')
      and o.status = 'active'
  );
$$;

revoke all on function private.has_operational_membership(uuid) from public, anon;
grant execute on function private.has_operational_membership(uuid) to authenticated;

-- Browser proof queueing must serialize requests without requiring UPDATE on the private
-- capacity opening. A transaction-scoped advisory lock protects the queue decision while
-- keeping private_capacity_openings browser read-only.
create unique index if not exists proof_jobs_one_active_per_input_idx
  on public.proof_jobs(order_version_id, capacity_opening_id)
  where status in ('queued', 'generating', 'generated', 'submitted');

drop policy if exists proof_jobs_factory_queue_insert on public.proof_jobs;
create policy proof_jobs_factory_queue_insert on public.proof_jobs
  for insert to authenticated
  with check (
    status = 'queued'
    and private.has_operational_membership(factory_organization_id)
    and exists (
      select 1
      from public.private_capacity_openings c
      join public.organizations factory on factory.id = c.factory_organization_id
      where c.id = proof_jobs.capacity_opening_id
        and c.factory_organization_id = proof_jobs.factory_organization_id
        and c.status = 'active'
        and c.circuit_version = proof_jobs.circuit_version
        and c.chain_period_id is not null
        and c.chain_process_id is not null
        and factory.role = 'factory'
        and factory.status = 'active'
    )
    and exists (
      select 1
      from public.order_versions ov
      join public.purchase_orders po on po.id = ov.purchase_order_id
      where ov.id = proof_jobs.order_version_id
        and po.factory_organization_id = proof_jobs.factory_organization_id
        and po.chain_order_id is not null
        and po.current_version = ov.version
        and po.current_order_commitment = ov.order_commitment
        and po.current_policy_hash = ov.policy_hash
        and po.status in ('proposed', 'feasible', 'infeasible', 'accepted')
        and exists (
          select 1 from public.private_capacity_openings c
          where c.id = proof_jobs.capacity_opening_id
            and c.policy_hash = ov.policy_hash
        )
    )
  );

create or replace function public.queue_capacity_proof(
  target_order_version_id uuid,
  target_capacity_opening_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  opening public.private_capacity_openings%rowtype;
  order_factory_id uuid;
  order_policy_hash text;
  order_version_number integer;
  current_version_number integer;
  current_commitment text;
  current_policy_hash text;
  version_commitment text;
  chain_order_identifier text;
  order_state public.order_status;
  job_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_capacity_opening_id::text, 0));
  select * into opening from public.private_capacity_openings c where c.id = target_capacity_opening_id;
  if opening.id is null or opening.status <> 'active' then raise exception 'active capacity opening required'; end if;
  if opening.chain_period_id is null or opening.chain_process_id is null then raise exception 'capacity opening is missing canonical period/process identifiers'; end if;
  if not private.has_operational_membership(opening.factory_organization_id) then raise exception 'active factory operator membership required'; end if;
  if not exists (select 1 from public.organizations o where o.id = opening.factory_organization_id and o.role = 'factory' and o.status = 'active') then raise exception 'active factory organization required'; end if;

  select po.factory_organization_id, ov.policy_hash, ov.version, po.current_version,
         po.current_order_commitment, po.current_policy_hash, ov.order_commitment,
         po.chain_order_id, po.status
    into order_factory_id, order_policy_hash, order_version_number, current_version_number,
         current_commitment, current_policy_hash, version_commitment,
         chain_order_identifier, order_state
  from public.order_versions ov
  join public.purchase_orders po on po.id = ov.purchase_order_id
  where ov.id = target_order_version_id;

  if order_factory_id is null or order_factory_id <> opening.factory_organization_id then raise exception 'order and capacity factory mismatch'; end if;
  if chain_order_identifier is null then raise exception 'order is not anchored to a canonical chain identifier'; end if;
  if current_version_number <> order_version_number or current_commitment <> version_commitment or current_policy_hash <> order_policy_hash then raise exception 'order version is not current'; end if;
  if order_state not in ('proposed', 'feasible', 'infeasible', 'accepted') then raise exception 'order is not in a proof-eligible state'; end if;
  if order_policy_hash <> opening.policy_hash then raise exception 'order and capacity policy mismatch'; end if;

  if exists (
    select 1 from public.proof_jobs pj
    where pj.order_version_id = target_order_version_id
      and pj.capacity_opening_id = target_capacity_opening_id
      and pj.status in ('queued', 'generating', 'generated', 'submitted')
  ) then
    raise exception 'an active proof job already exists';
  end if;

  begin
    insert into public.proof_jobs (factory_organization_id, order_version_id, capacity_opening_id, status, circuit_version)
    values (opening.factory_organization_id, target_order_version_id, target_capacity_opening_id, 'queued', opening.circuit_version)
    returning id into job_id;
  exception when unique_violation then
    raise exception 'an active proof job already exists';
  end;
  return job_id;
end;
$$;

revoke all on function public.queue_capacity_proof(uuid,uuid) from public, anon;
grant execute on function public.queue_capacity_proof(uuid,uuid) to authenticated;

-- Draft order mutations enforce the same input and active-role boundaries below the UI.
drop policy if exists purchase_orders_buyer_draft_insert on public.purchase_orders;
create policy purchase_orders_buyer_draft_insert on public.purchase_orders
  for insert to authenticated
  with check (
    status = 'draft' and current_version = 0
    and current_order_commitment is null and current_policy_hash is null
    and created_by = (select auth.uid())
    and private.has_operational_membership(buyer_organization_id)
    and char_length(btrim(external_reference)) between 1 and 120
    and title is not null and char_length(btrim(title)) between 2 and 180
    and (product_category is null or char_length(btrim(product_category)) <= 120)
    and quantity is not null and quantity > 0 and quantity <= 1000000000
    and unit is not null and char_length(btrim(unit)) between 1 and 30
    and exists (select 1 from public.organizations buyer where buyer.id = purchase_orders.buyer_organization_id and buyer.role = 'buyer' and buyer.status = 'active')
    and exists (select 1 from public.organizations factory where factory.id = purchase_orders.factory_organization_id and factory.role = 'factory' and factory.status = 'active')
  );

drop policy if exists purchase_orders_buyer_draft_update on public.purchase_orders;
create policy purchase_orders_buyer_draft_update on public.purchase_orders
  for update to authenticated
  using (status = 'draft' and current_version = 0 and private.has_operational_membership(buyer_organization_id))
  with check (
    status = 'draft' and current_version = 0
    and current_order_commitment is null and current_policy_hash is null
    and private.has_operational_membership(buyer_organization_id)
    and char_length(btrim(external_reference)) between 1 and 120
    and title is not null and char_length(btrim(title)) between 2 and 180
    and (product_category is null or char_length(btrim(product_category)) <= 120)
    and quantity is not null and quantity > 0 and quantity <= 1000000000
    and unit is not null and char_length(btrim(unit)) between 1 and 30
  );

drop policy if exists purchase_orders_buyer_draft_delete on public.purchase_orders;
create policy purchase_orders_buyer_draft_delete on public.purchase_orders
  for delete to authenticated
  using (status = 'draft' and current_version = 0 and private.has_operational_membership(buyer_organization_id));

create or replace function public.update_purchase_order_draft(
  target_order_id uuid,
  new_external_reference text,
  new_title text,
  new_product_category text,
  new_quantity numeric,
  new_unit text,
  new_requested_delivery_date date default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare buyer_id uuid;
begin
  select po.buyer_organization_id into buyer_id from public.purchase_orders po
  where po.id = target_order_id and po.status = 'draft' and po.current_version = 0;
  if buyer_id is null then raise exception 'draft order not found'; end if;
  if not private.has_operational_membership(buyer_id) then raise exception 'active buyer operator membership required'; end if;
  if new_quantity is null or new_quantity <= 0 or new_quantity > 1000000000 then raise exception 'quantity must be between 0 and 1000000000'; end if;
  if new_external_reference is null or char_length(btrim(new_external_reference)) not between 1 and 120 then raise exception 'external reference must be between 1 and 120 characters'; end if;
  if new_title is null or char_length(btrim(new_title)) not between 2 and 180 then raise exception 'title must be between 2 and 180 characters'; end if;
  if new_product_category is not null and char_length(btrim(new_product_category)) > 120 then raise exception 'product category must be at most 120 characters'; end if;
  if new_unit is null or char_length(btrim(new_unit)) not between 1 and 30 then raise exception 'unit must be between 1 and 30 characters'; end if;

  update public.purchase_orders
  set external_reference = btrim(new_external_reference), title = btrim(new_title),
      product_category = nullif(btrim(new_product_category), ''), quantity = new_quantity,
      unit = btrim(new_unit), requested_delivery_date = new_requested_delivery_date, updated_at = now()
  where id = target_order_id and status = 'draft' and current_version = 0;
end;
$$;

revoke all on function public.update_purchase_order_draft(uuid,text,text,text,numeric,text,date) from public, anon;
grant execute on function public.update_purchase_order_draft(uuid,text,text,text,numeric,text,date) to authenticated;

-- A role downgrade or organization suspension takes effect immediately for staged work.
drop policy if exists capacity_certification_auditor_delete_prepared on public.capacity_certification_jobs;
create policy capacity_certification_auditor_delete_prepared on public.capacity_certification_jobs
  for delete to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and credential_tx_hash is null and certification_tx_hash is null and private.has_operational_membership(auditor_organization_id));

drop policy if exists order_authorization_jobs_buyer_delete_prepared on public.order_authorization_jobs;
create policy order_authorization_jobs_buyer_delete_prepared on public.order_authorization_jobs
  for delete to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.has_operational_membership(buyer_organization_id));

drop policy if exists order_authorization_jobs_buyer_sign on public.order_authorization_jobs;
create policy order_authorization_jobs_buyer_sign on public.order_authorization_jobs
  for update to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.has_operational_membership(buyer_organization_id))
  with check (created_by = (select auth.uid()) and status = 'signed' and buyer_signature is not null and chain_tx_hash is null and private.has_operational_membership(buyer_organization_id));

drop policy if exists order_authorization_jobs_buyer_insert on public.order_authorization_jobs;
create policy order_authorization_jobs_buyer_insert on public.order_authorization_jobs
  for insert to authenticated
  with check (
    created_by = (select auth.uid()) and status = 'prepared' and buyer_signature is null and chain_tx_hash is null
    and private.has_operational_membership(buyer_organization_id)
    and exists (
      select 1 from public.purchase_orders po
      join public.organizations buyer on buyer.id = po.buyer_organization_id
      where po.id = order_authorization_jobs.purchase_order_id
        and po.buyer_organization_id = order_authorization_jobs.buyer_organization_id
        and po.factory_organization_id = order_authorization_jobs.factory_organization_id
        and po.chain_order_id = order_authorization_jobs.chain_order_id
        and po.current_version + 1 = order_authorization_jobs.target_version
        and po.status in ('draft', 'proposed', 'feasible', 'infeasible')
        and buyer.role = 'buyer' and buyer.status = 'active'
    )
    and not exists (
      select 1 from public.order_cancellation_jobs c
      where c.purchase_order_id = order_authorization_jobs.purchase_order_id
        and c.status in ('prepared','signed','submitting','submitted','confirmed')
    )
  );

drop policy if exists order_cancellation_jobs_buyer_delete_prepared on public.order_cancellation_jobs;
create policy order_cancellation_jobs_buyer_delete_prepared on public.order_cancellation_jobs
  for delete to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.has_operational_membership(buyer_organization_id));

drop policy if exists order_cancellation_jobs_buyer_sign on public.order_cancellation_jobs;
create policy order_cancellation_jobs_buyer_sign on public.order_cancellation_jobs
  for update to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.has_operational_membership(buyer_organization_id))
  with check (created_by = (select auth.uid()) and status = 'signed' and buyer_signature is not null and chain_tx_hash is null and private.has_operational_membership(buyer_organization_id));

drop policy if exists subcontract_jobs_parent_factory_delete_prepared on public.subcontract_authorization_jobs;
create policy subcontract_jobs_parent_factory_delete_prepared on public.subcontract_authorization_jobs
  for delete to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and parent_factory_signature is null and chain_tx_hash is null and private.has_operational_membership(parent_factory_organization_id));

drop policy if exists subcontract_jobs_parent_factory_sign on public.subcontract_authorization_jobs;
create policy subcontract_jobs_parent_factory_sign on public.subcontract_authorization_jobs
  for update to authenticated
  using (created_by = (select auth.uid()) and status = 'prepared' and private.has_operational_membership(parent_factory_organization_id))
  with check (created_by = (select auth.uid()) and status = 'signed' and parent_factory_signature is not null and chain_tx_hash is null and worker_claim_token is null and private.has_operational_membership(parent_factory_organization_id));

-- Direct invitation-table writes must not bypass active-organization checks.
drop policy if exists organization_invitations_admin_insert on public.organization_invitations;
create policy organization_invitations_admin_insert on public.organization_invitations
  for insert to authenticated
  with check (
    private.is_organization_admin(organization_id)
    and invited_by = (select auth.uid()) and accepted_at is null and expires_at > now()
    and exists (select 1 from public.organizations o where o.id = organization_invitations.organization_id and o.status = 'active')
  );

drop policy if exists organization_members_invitee_insert on public.organization_members;
create policy organization_members_invitee_insert on public.organization_members
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1 from public.organization_invitations i
      join public.organizations o on o.id = i.organization_id
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now() and o.status = 'active'
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
      join public.organizations o on o.id = i.organization_id
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null and i.expires_at > now() and o.status = 'active'
    )
  );
