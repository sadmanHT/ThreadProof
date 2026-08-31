-- RLS policies require underlying table privileges before PostgreSQL evaluates row predicates.
-- Restore only the browser-readable surfaces that already have authenticated SELECT policies.
grant select on public.organizations to authenticated;
grant select on public.organization_members to authenticated;
grant select on public.credentials to authenticated;
grant select on public.purchase_orders to authenticated;
grant select on public.order_versions to authenticated;
grant select on public.private_capacity_openings to authenticated;
grant select on public.capacity_allocations to authenticated;
grant select on public.proof_jobs to authenticated;
grant select on public.chain_events to authenticated;

-- Reassert private boundaries: browser sessions must never read protected identity mappings or proof witnesses.
revoke select on public.encrypted_supplier_identities from authenticated;
revoke select on public.proof_job_private_state from authenticated;
