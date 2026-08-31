-- Publish generated proof material and its encrypted next private opening atomically.
-- The function succeeds only while the caller still owns the exact worker claim token.
-- This is operational coordination only; CapacityVault remains canonical for capacity state.

create or replace function public.finalize_proof_generation(
  target_job_id uuid,
  target_worker_claim_token uuid,
  generated_proof jsonb,
  generated_public_inputs jsonb,
  next_capacity_ciphertext bytea,
  next_randomness_ciphertext bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owned_job_id uuid;
begin
  update public.proof_jobs
  set status = 'generated',
      proof = generated_proof,
      public_inputs = generated_public_inputs,
      error_code = null,
      error_detail = null,
      worker_claim_token = null,
      worker_claimed_at = null
  where id = target_job_id
    and status = 'generating'
    and worker_claim_token = target_worker_claim_token
  returning id into owned_job_id;

  if owned_job_id is null then
    return false;
  end if;

  insert into public.proof_job_private_state (
    proof_job_id,
    next_capacity_ciphertext,
    next_randomness_ciphertext
  ) values (
    target_job_id,
    next_capacity_ciphertext,
    next_randomness_ciphertext
  )
  on conflict (proof_job_id) do update
  set next_capacity_ciphertext = excluded.next_capacity_ciphertext,
      next_randomness_ciphertext = excluded.next_randomness_ciphertext;

  return true;
end;
$$;

revoke all on function public.finalize_proof_generation(uuid, uuid, jsonb, jsonb, bytea, bytea)
  from public, anon, authenticated;
grant execute on function public.finalize_proof_generation(uuid, uuid, jsonb, jsonb, bytea, bytea)
  to service_role;

comment on function public.finalize_proof_generation(uuid, uuid, jsonb, jsonb, bytea, bytea) is
'Claim-token-guarded atomic publication of a generated proof and encrypted next opening. Operational only; blockchain state remains canonical.';
