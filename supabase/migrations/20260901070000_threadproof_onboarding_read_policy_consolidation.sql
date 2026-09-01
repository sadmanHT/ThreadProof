-- Consolidate two permissive authenticated SELECT policies into one equivalent OR predicate.
-- This changes policy evaluation cost only; it does not broaden onboarding visibility.

drop policy if exists onboarding_factory_reviewer_read
  on public.organization_onboarding_requests;

drop policy if exists onboarding_request_self_read
  on public.organization_onboarding_requests;

create policy onboarding_request_visible_read
  on public.organization_onboarding_requests
  for select
  to authenticated
  using (
    requested_by = (select auth.uid())
    or (
      requested_role = 'factory'::organization_role
      and exists (
        select 1
        from public.organization_members membership
        join public.organizations organization
          on organization.id = membership.organization_id
        where membership.user_id = (select auth.uid())
          and membership.active = true
          and organization.status = 'active'::organization_status
          and organization.role = any (
            array[
              'factory'::organization_role,
              'industry'::organization_role,
              'auditor'::organization_role,
              'independent'::organization_role
            ]
          )
      )
    )
  );

comment on policy onboarding_request_visible_read
  on public.organization_onboarding_requests is
'Authenticated users may read their own onboarding requests. Active factory/industry/auditor/independent consortium members may additionally review factory onboarding requests. Equivalent to the previous two permissive SELECT policies, consolidated for predictable RLS evaluation.';
