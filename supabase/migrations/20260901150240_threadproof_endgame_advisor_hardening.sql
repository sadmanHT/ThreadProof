create index if not exists capacity_release_jobs_capacity_opening_idx
  on public.capacity_release_jobs(capacity_opening_id);
create index if not exists capacity_release_jobs_order_version_idx
  on public.capacity_release_jobs(order_version_id);
create index if not exists protected_identity_disclosures_identity_idx
  on public.protected_identity_disclosures(encrypted_supplier_identity_id);

drop policy if exists capacity_release_jobs_browser_deny on public.capacity_release_jobs;
create policy capacity_release_jobs_browser_deny
  on public.capacity_release_jobs
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists credential_private_packages_browser_deny on public.credential_private_packages;
create policy credential_private_packages_browser_deny
  on public.credential_private_packages
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists encrypted_supplier_identities_browser_deny on public.encrypted_supplier_identities;
create policy encrypted_supplier_identities_browser_deny
  on public.encrypted_supplier_identities
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists protected_identity_disclosures_browser_deny on public.protected_identity_disclosures;
create policy protected_identity_disclosures_browser_deny
  on public.protected_identity_disclosures
  for all
  to anon, authenticated
  using (false)
  with check (false);
