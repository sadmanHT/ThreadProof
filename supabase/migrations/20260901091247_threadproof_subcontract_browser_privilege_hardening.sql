revoke select on public.subcontract_authorization_jobs from authenticated;
grant select (
  id,
  parent_order_id,
  child_order_id,
  parent_chain_order_id,
  child_chain_order_id,
  buyer_organization_id,
  parent_factory_organization_id,
  subcontractor_organization_id,
  parent_version,
  child_version,
  parent_version_hash,
  child_version_hash,
  period_id,
  process_id,
  policy_hash,
  chain_compliance_credential_id,
  chain_process_credential_id,
  chain_capacity_allocation_id,
  sequence,
  nonce,
  deadline,
  status,
  chain_tx_hash,
  chain_block_number,
  confirmed_at,
  error_code,
  error_detail,
  created_by,
  created_at,
  updated_at
) on public.subcontract_authorization_jobs to authenticated;

comment on column public.subcontract_authorization_jobs.worker_claim_token is
'Service-only lease token. Browser roles are intentionally denied SELECT and UPDATE access.';
comment on column public.subcontract_authorization_jobs.parent_factory_signature is
'Validated EIP-712 signature used only by the relay pipeline. Browser roles may write it during the prepared-to-signed transition but are intentionally denied SELECT access afterwards.';
