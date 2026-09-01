-- Service-only encrypted credential bodies for portable credential packages.
-- CredentialRegistry remains canonical for credential identity, digest, scope, validity and status.

create table if not exists public.credential_private_packages (
  credential_id uuid primary key references public.credentials(id) on delete restrict,
  encrypted_body bytea not null,
  encryption_key_version integer not null check (encryption_key_version > 0),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.credential_private_packages enable row level security;
revoke all on table public.credential_private_packages from public, anon, authenticated;
grant select, insert, update on table public.credential_private_packages to service_role;

comment on table public.credential_private_packages is
'Service-only encrypted credential bodies. Portable exports must re-verify the decrypted body against canonical CredentialRegistry state before release.';
