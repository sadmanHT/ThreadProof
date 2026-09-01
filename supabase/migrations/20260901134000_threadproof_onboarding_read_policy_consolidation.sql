-- Preserve onboarding read semantics while avoiding multiple permissive SELECT policies.
-- A requester may read their own request. Active consortium reviewers from the
-- existing factory/industry/auditor/independent roles may review factory requests.

drop policy if exists onboarding_factory_reviewer_read
  on public.organization_onboarding_requests;
drop policy if exists onboarding_request_self_read
  on public.organization_onboarding_requests;

create policy onboarding_request_read
  on public.organization_onboarding_requests
  for select
  to authenticated
  using (
    requested_by = (select auth.uid())
    or (
      requested_role = 'factory'::public.organization_role
      and exists (
        select 1
        from public.organization_members membership
        join public.organizations organization
          on organization.id = membership.organization_id
        where membership.user_id = (select auth.uid())
          and membership.active = true
          and organization.status = 'active'::public.organization_status
          and organization.role in (
            'factory'::public.organization_role,
            'industry'::public.organization_role,
            'auditor'::public.organization_role,
            'independent'::public.organization_role
          )
      )
    )
  );

comment on policy onboarding_request_read on public.organization_onboarding_requests is
'Combined requester/self and authorized factory-reviewer visibility. Consolidation preserves prior RLS semantics while avoiding duplicate permissive SELECT policy evaluation.';
