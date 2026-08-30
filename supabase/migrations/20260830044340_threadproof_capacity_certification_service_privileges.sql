-- The service-role indexer reconciles staged certifications but must not receive table-maintenance privileges.
revoke truncate, trigger, references, maintain on public.capacity_certification_jobs from service_role;
grant select, update on public.capacity_certification_jobs to service_role;

-- Future public tables should not automatically grant maintenance privileges to service_role either.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references, maintain on tables from service_role;
