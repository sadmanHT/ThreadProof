-- RLS does not protect TRUNCATE; browser roles must not hold table-maintenance privileges.
revoke truncate, trigger, references on public.capacity_certification_jobs from anon, authenticated;
revoke all on public.capacity_certification_jobs from anon;

-- Reassert only the browser privileges required by the auditor workflow.
grant select, delete on public.capacity_certification_jobs to authenticated;
grant insert (
  factory_organization_id,
  auditor_organization_id,
  chain_credential_id,
  chain_period_id,
  chain_process_id,
  period_label,
  process_label,
  policy_hash,
  capacity_commitment,
  credential_scope_hash,
  credential_digest,
  assessment_methodology,
  valid_from,
  valid_until,
  circuit_version,
  encrypted_capacity,
  encrypted_randomness,
  encryption_key_version,
  status,
  created_by
) on public.capacity_certification_jobs to authenticated;
