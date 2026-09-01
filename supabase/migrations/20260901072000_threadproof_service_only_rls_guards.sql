-- Make browser-deny intent explicit on operational/protected tables.
-- This migration grants no new service or governance access. Existing table grants and
-- privileged RLS-bypass roles remain authoritative; anon/authenticated must stay denied
-- even if future table grants drift.

revoke all privileges on table public.chain_indexer_cursors from public, anon, authenticated;
revoke all privileges on table public.encrypted_supplier_identities from public, anon, authenticated;

drop policy if exists chain_indexer_cursors_browser_deny
  on public.chain_indexer_cursors;
create policy chain_indexer_cursors_browser_deny
  on public.chain_indexer_cursors
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists encrypted_supplier_identities_browser_deny
  on public.encrypted_supplier_identities;
create policy encrypted_supplier_identities_browser_deny
  on public.encrypted_supplier_identities
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on policy chain_indexer_cursors_browser_deny
  on public.chain_indexer_cursors is
'Indexer cursor state is operational data. Browser roles are explicitly denied; this policy grants no privileged access and preserves the existing service-role/table-grant model.';

comment on policy encrypted_supplier_identities_browser_deny
  on public.encrypted_supplier_identities is
'Protected supplier identity mappings are not browser-readable. This policy grants no service/governance access and preserves the existing privileged table-grant/RLS-bypass model.';
