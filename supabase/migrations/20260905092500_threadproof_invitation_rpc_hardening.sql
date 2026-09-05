-- Invitation and membership mutations are exposed only through narrowly validated RPCs.
-- Browser sessions keep read access under RLS but no direct INSERT/UPDATE capability.

create or replace function public.create_organization_invitation(
  target_organization_id uuid,
  invite_email text,
  invite_member_role text default 'viewer',
  expires_in_hours integer default 72
)
returns table(invitation_id uuid, invite_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_token text;
  new_id uuid;
  expiry timestamptz;
  normalized_email text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not private.is_organization_admin(target_organization_id) then raise exception 'organization admin required'; end if;
  if invite_member_role not in ('admin', 'operator', 'viewer', 'signer') then raise exception 'invalid member role'; end if;
  if expires_in_hours < 1 or expires_in_hours > 720 then raise exception 'expiry must be between 1 and 720 hours'; end if;

  normalized_email := lower(btrim(coalesce(invite_email, '')));
  if char_length(normalized_email) < 3 or char_length(normalized_email) > 320 or position('@' in normalized_email) < 2 then
    raise exception 'valid email required';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = target_organization_id and o.status = 'active'
  ) then
    raise exception 'organization is not active';
  end if;

  raw_token := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  expiry := now() + make_interval(hours => expires_in_hours);

  insert into public.organization_invitations (
    organization_id, email, member_role, token_hash, expires_at, invited_by
  ) values (
    target_organization_id,
    normalized_email,
    invite_member_role,
    pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    expiry,
    auth.uid()
  ) returning id into new_id;

  return query select new_id, raw_token, expiry;
end;
$$;

create or replace function public.accept_organization_invitation(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.organization_invitations%rowtype;
  caller_email text;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if invite_token is null or invite_token !~ '^[0-9a-fA-F]{48}$' then raise exception 'invitation invalid or expired'; end if;

  caller_email := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  if caller_email = '' then raise exception 'authenticated email required'; end if;

  select * into invitation
  from public.organization_invitations i
  where i.token_hash = pg_catalog.encode(extensions.digest(invite_token, 'sha256'), 'hex')
    and i.accepted_at is null
    and i.expires_at > now()
  for update;

  if invitation.id is null then raise exception 'invitation invalid or expired'; end if;
  if lower(invitation.email) <> caller_email then raise exception 'invitation email does not match authenticated user'; end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = invitation.organization_id and o.status = 'active'
  ) then
    raise exception 'organization is not active';
  end if;

  insert into public.organization_members (organization_id, user_id, member_role, active)
  values (invitation.organization_id, auth.uid(), invitation.member_role, true)
  on conflict (organization_id, user_id)
  do update set member_role = excluded.member_role, active = true;

  update public.organization_invitations
  set accepted_at = now()
  where id = invitation.id and accepted_at is null;

  if not found then raise exception 'invitation was already accepted'; end if;
  return invitation.organization_id;
end;
$$;

revoke all on function public.create_organization_invitation(uuid,text,text,integer) from public, anon;
grant execute on function public.create_organization_invitation(uuid,text,text,integer) to authenticated;
revoke all on function public.accept_organization_invitation(text) from public, anon;
grant execute on function public.accept_organization_invitation(text) to authenticated;

revoke insert (organization_id, email, member_role, token_hash, expires_at, invited_by)
  on public.organization_invitations from authenticated;
revoke update (accepted_at)
  on public.organization_invitations from authenticated;
revoke insert (organization_id, user_id, member_role, active)
  on public.organization_members from authenticated;
revoke update (member_role, active)
  on public.organization_members from authenticated;

-- These mutation policies are no longer browser entry points. Reads retain their existing RLS.
drop policy if exists organization_invitations_admin_insert on public.organization_invitations;
drop policy if exists organization_invitations_recipient_update on public.organization_invitations;
drop policy if exists organization_members_invitee_insert on public.organization_members;
drop policy if exists organization_members_invitee_update on public.organization_members;
