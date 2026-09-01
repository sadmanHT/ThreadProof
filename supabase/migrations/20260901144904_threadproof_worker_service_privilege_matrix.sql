grant select, update on table public.organizations to service_role;
grant select, insert, update on table public.credentials to service_role;
grant select, update on table public.purchase_orders to service_role;
grant select, insert, update on table public.order_versions to service_role;
grant select, insert, update on table public.private_capacity_openings to service_role;
grant select, update on table public.proof_jobs to service_role;
grant select on table public.capacity_allocations to service_role;
grant select, insert, update on table public.chain_events to service_role;
grant select, update on table public.order_authorization_jobs to service_role;

revoke delete, truncate on table public.organizations from service_role;
revoke delete, truncate on table public.credentials from service_role;
revoke delete, truncate on table public.purchase_orders from service_role;
revoke delete, truncate on table public.order_versions from service_role;
revoke delete, truncate on table public.private_capacity_openings from service_role;
revoke delete, truncate on table public.proof_jobs from service_role;
revoke delete, truncate on table public.capacity_allocations from service_role;
revoke delete, truncate on table public.chain_events from service_role;
revoke delete, truncate on table public.order_authorization_jobs from service_role;

comment on table public.chain_events is
'Rebuildable canonical-event projection. The service-role indexer may read/upsert events; browser writes and destructive service operations remain forbidden.';
