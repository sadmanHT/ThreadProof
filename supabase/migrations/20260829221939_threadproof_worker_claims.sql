alter table public.proof_jobs
  add column worker_claim_token uuid,
  add column worker_claimed_at timestamptz;
create index proof_jobs_claimable_idx
  on public.proof_jobs(status, created_at)
  where worker_claim_token is null;
