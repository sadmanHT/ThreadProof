create schema if not exists threadproof_e2e_private;
revoke all on schema threadproof_e2e_private from public, anon, authenticated;

drop function if exists public.cleanup_browser_chain_stage2_e2e_fixture(uuid, text);
drop function if exists threadproof_e2e_private.cleanup_browser_chain_stage2_e2e_fixture_impl(uuid, text);

create function threadproof_e2e_private.cleanup_browser_chain_stage2_e2e_fixture_impl(
  target_order_id uuid,
  target_run_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order public.purchase_orders%rowtype;
  fixture_prefix text;
  version_count integer;
  certification record;
  credential record;
  opening record;
begin
  if target_order_id is null then
    raise exception 'target_order_id is required';
  end if;
  if target_run_id is null or target_run_id !~ '^[0-9]+-[0-9]+$' then
    raise exception 'target_run_id must match the GitHub run-attempt namespace';
  end if;

  fixture_prefix := 'E2E-CHAIN-' || target_run_id || '-POFC-';

  select po.* into target_order
  from public.purchase_orders po
  where po.id = target_order_id
  for update;

  if target_order.id is null then
    return false;
  end if;
  if target_order.external_reference not like fixture_prefix || '%' then
    raise exception 'Refusing Stage 2 cleanup outside exact browser-chain PoFC namespace';
  end if;
  if target_order.current_version not in (0, 1) then
    raise exception 'Refusing Stage 2 cleanup for an order beyond version 1';
  end if;
  if target_order.status not in ('draft', 'proposed', 'feasible', 'infeasible') then
    raise exception 'Refusing Stage 2 cleanup for order status %', target_order.status;
  end if;

  select count(*) into version_count
  from public.order_versions ov
  where ov.purchase_order_id = target_order_id;
  if version_count > 1 then
    raise exception 'Refusing Stage 2 cleanup for an order with more than one immutable version';
  end if;

  if exists (
    select 1 from public.subcontract_authorization_jobs sj
    where sj.parent_order_id = target_order_id or sj.child_order_id = target_order_id
  ) then
    raise exception 'Refusing Stage 2 cleanup after subcontract authorization state exists';
  end if;

  if exists (
    select 1 from public.order_cancellation_jobs cj
    where cj.purchase_order_id = target_order_id
  ) then
    raise exception 'Refusing Stage 2 cleanup after cancellation state exists';
  end if;

  if exists (
    select 1
    from public.capacity_release_jobs rj
    join public.order_versions ov on ov.id = rj.order_version_id
    where ov.purchase_order_id = target_order_id
  ) then
    raise exception 'Refusing Stage 2 cleanup after capacity-release state exists';
  end if;

  -- Every namespaced certification must belong to the target factory and remain isolated
  -- from portable credential-package material. This catches failures before proof queueing too.
  for certification in
    select ccj.*
    from public.capacity_certification_jobs ccj
    where ccj.period_label like fixture_prefix || '%'
    for update
  loop
    if target_order.factory_organization_id is null
       or certification.factory_organization_id <> target_order.factory_organization_id then
      raise exception 'Namespaced Stage 2 certification belongs to a different factory/order';
    end if;

    if certification.chain_credential_id is not null then
      select c.* into credential
      from public.credentials c
      where lower(c.chain_credential_id) = lower(certification.chain_credential_id)
      for update;

      if credential.id is not null then
        if credential.subject_organization_id <> target_order.factory_organization_id then
          raise exception 'Namespaced Stage 2 credential subject does not match target factory';
        end if;
        if exists (
          select 1 from public.credential_private_packages cpp
          where cpp.credential_id = credential.id
        ) then
          raise exception 'Refusing Stage 2 cleanup after portable credential-package state exists';
        end if;

        for opening in
          select pco.*
          from public.private_capacity_openings pco
          where pco.capacity_credential_id = credential.id
          for update
        loop
          if opening.factory_organization_id <> target_order.factory_organization_id
             or opening.period_id <> certification.period_label
             or opening.period_id not like fixture_prefix || '%' then
            raise exception 'Namespaced Stage 2 private opening does not match target certification';
          end if;

          if exists (
            select 1
            from public.proof_jobs pj
            join public.order_versions ov on ov.id = pj.order_version_id
            where pj.capacity_opening_id = opening.id
              and ov.purchase_order_id <> target_order_id
          ) then
            raise exception 'Refusing Stage 2 cleanup: private opening is referenced by another order proof';
          end if;

          if exists (
            select 1
            from public.capacity_allocations ca
            join public.order_versions ov on ov.id = ca.order_version_id
            where ca.capacity_opening_id = opening.id
              and ov.purchase_order_id <> target_order_id
          ) then
            raise exception 'Refusing Stage 2 cleanup: private opening is allocated to another order';
          end if;

          if exists (
            select 1 from public.capacity_release_jobs rj
            where rj.capacity_opening_id = opening.id
          ) then
            raise exception 'Refusing Stage 2 cleanup: private opening has capacity-release history';
          end if;
        end loop;
      end if;
    end if;
  end loop;

  -- Proof-linked openings must also be explicitly namespaced, even if a failed indexer run
  -- prevented the certification job/credential mirror from reaching its final status.
  for opening in
    select pco.*
    from public.private_capacity_openings pco
    where exists (
      select 1
      from public.proof_jobs pj
      join public.order_versions ov on ov.id = pj.order_version_id
      where pj.capacity_opening_id = pco.id
        and ov.purchase_order_id = target_order_id
    )
    for update
  loop
    if opening.factory_organization_id <> target_order.factory_organization_id
       or opening.period_id not like fixture_prefix || '%' then
      raise exception 'Proof-linked opening is outside the exact Stage 2 fixture namespace';
    end if;
    if exists (
      select 1
      from public.proof_jobs pj
      join public.order_versions ov on ov.id = pj.order_version_id
      where pj.capacity_opening_id = opening.id
        and ov.purchase_order_id <> target_order_id
    ) then
      raise exception 'Refusing Stage 2 cleanup: proof-linked opening is shared with another order';
    end if;
    if exists (
      select 1
      from public.capacity_allocations ca
      join public.order_versions ov on ov.id = ca.order_version_id
      where ca.capacity_opening_id = opening.id
        and ov.purchase_order_id <> target_order_id
    ) then
      raise exception 'Refusing Stage 2 cleanup: proof-linked allocation belongs to another order';
    end if;
  end loop;

  delete from public.capacity_allocations ca
  using public.order_versions ov
  where ca.order_version_id = ov.id
    and ov.purchase_order_id = target_order_id;

  delete from public.proof_jobs pj
  using public.order_versions ov
  where pj.order_version_id = ov.id
    and ov.purchase_order_id = target_order_id;

  -- Remove only private openings created by this exact run's namespaced certification.
  delete from public.private_capacity_openings pco
  using public.credentials c, public.capacity_certification_jobs ccj
  where pco.capacity_credential_id = c.id
    and ccj.chain_credential_id is not null
    and lower(c.chain_credential_id) = lower(ccj.chain_credential_id)
    and ccj.period_label like fixture_prefix || '%'
    and pco.period_id = ccj.period_label
    and pco.factory_organization_id = target_order.factory_organization_id;

  -- Capacity credentials created by this test are disposable only when no remaining
  -- private opening, credential package, or subcontract row references them.
  delete from public.credentials c
  using public.capacity_certification_jobs ccj
  where ccj.chain_credential_id is not null
    and lower(c.chain_credential_id) = lower(ccj.chain_credential_id)
    and ccj.period_label like fixture_prefix || '%'
    and c.subject_organization_id = target_order.factory_organization_id
    and not exists (select 1 from public.private_capacity_openings pco where pco.capacity_credential_id = c.id)
    and not exists (select 1 from public.credential_private_packages cpp where cpp.credential_id = c.id)
    and not exists (
      select 1 from public.subcontract_authorization_jobs sj
      where sj.compliance_credential_id = c.id or sj.process_credential_id = c.id
    );

  delete from public.capacity_certification_jobs ccj
  where ccj.period_label like fixture_prefix || '%'
    and ccj.factory_organization_id = target_order.factory_organization_id;

  delete from public.purchase_orders po
  where po.id = target_order_id;

  return true;
end;
$$;

revoke all on function threadproof_e2e_private.cleanup_browser_chain_stage2_e2e_fixture_impl(uuid, text)
from public, anon, authenticated;
grant execute on function threadproof_e2e_private.cleanup_browser_chain_stage2_e2e_fixture_impl(uuid, text)
to service_role;

create function public.cleanup_browser_chain_stage2_e2e_fixture(
  target_order_id uuid,
  target_run_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user <> 'service_role' then
    raise exception 'cleanup_browser_chain_stage2_e2e_fixture is service-role only';
  end if;
  return threadproof_e2e_private.cleanup_browser_chain_stage2_e2e_fixture_impl(target_order_id, target_run_id);
end;
$$;

revoke all on function public.cleanup_browser_chain_stage2_e2e_fixture(uuid, text)
from public, anon, authenticated;
grant execute on function public.cleanup_browser_chain_stage2_e2e_fixture(uuid, text)
to service_role;

comment on function public.cleanup_browser_chain_stage2_e2e_fixture(uuid, text) is
'Test-only cleanup for exact E2E-CHAIN-<run>-POFC fixtures. Refuses cross-order, subcontract, release, cancellation, or portable-credential dependencies before deleting rebuildable disposable mirrors.';
