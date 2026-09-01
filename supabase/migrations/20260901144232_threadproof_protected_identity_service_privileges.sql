revoke all on table public.encrypted_supplier_identities from public, anon, authenticated;
grant select, insert, update on table public.encrypted_supplier_identities to service_role;
revoke delete, truncate on table public.encrypted_supplier_identities from service_role;

comment on table public.encrypted_supplier_identities is
'Service-only encrypted pseudonym-to-identity mapping for due-process disclosure. Browser roles have no privileges; disclosure requires canonical Charter authorization before decryption/export.';
