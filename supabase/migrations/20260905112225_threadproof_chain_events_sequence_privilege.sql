grant usage, select on sequence public.chain_events_id_seq to service_role;
revoke all on sequence public.chain_events_id_seq from anon, authenticated;

comment on sequence public.chain_events_id_seq is
'Service-role-only identity sequence for the rebuildable chain_events indexer projection. Browser roles must not allocate canonical-event projection IDs.';
