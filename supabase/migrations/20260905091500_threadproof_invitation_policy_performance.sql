-- Evaluate auth.jwt() once per statement in invitation membership policies rather than
-- re-evaluating the helper for every candidate row.
drop policy if exists organization_members_invitee_insert on public.organization_members;
create policy organization_members_invitee_insert on public.organization_members
  for insert to authenticated
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1
      from public.organization_invitations i
      join public.organizations o on o.id = i.organization_id
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce(((select auth.jwt()) ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null
        and i.expires_at > now()
        and o.status = 'active'
    )
  );

drop policy if exists organization_members_invitee_update on public.organization_members;
create policy organization_members_invitee_update on public.organization_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and active
    and exists (
      select 1
      from public.organization_invitations i
      join public.organizations o on o.id = i.organization_id
      where i.organization_id = organization_members.organization_id
        and lower(i.email) = lower(coalesce(((select auth.jwt()) ->> 'email'), ''))
        and i.member_role = organization_members.member_role
        and i.accepted_at is null
        and i.expires_at > now()
        and o.status = 'active'
    )
  );
