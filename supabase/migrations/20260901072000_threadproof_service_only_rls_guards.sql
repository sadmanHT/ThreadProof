-- Make service-only table intent explicit for browser roles.
-- service_role has BYPASSRLS; anon/authenticated must remain denied even if future grants drift.

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
'Indexer cursor state is service-only operational data. Browser roles are explicitly denied; service_role bypasses RLS.';

comment on policy encrypted_supplier_identities_browser_deny
  on public.encrypted_supplier_identities is
'Protected supplier identity mappings are service/governance-only. Browser roles are explicitly denied; service_role bypasses RLS.';
