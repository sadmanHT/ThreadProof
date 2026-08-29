-- Preserve exact BN254/uint256 values across PostgREST/JavaScript boundaries.
-- These are cryptographic integers, not arithmetic application fields.

alter table public.private_capacity_openings
  alter column capacity_commitment type text using capacity_commitment::text;
alter table public.private_capacity_openings
  add constraint capacity_commitment_decimal_format check (capacity_commitment ~ '^[0-9]+$');

alter table public.capacity_allocations
  alter column old_commitment type text using old_commitment::text,
  alter column new_commitment type text using new_commitment::text,
  alter column order_commitment type text using order_commitment::text,
  alter column nullifier type text using nullifier::text;
alter table public.capacity_allocations
  add constraint capacity_allocations_old_decimal_format check (old_commitment ~ '^[0-9]+$'),
  add constraint capacity_allocations_new_decimal_format check (new_commitment ~ '^[0-9]+$'),
  add constraint capacity_allocations_order_decimal_format check (order_commitment ~ '^[0-9]+$'),
  add constraint capacity_allocations_nullifier_decimal_format check (nullifier ~ '^[0-9]+$');

alter table public.order_authorization_jobs
  alter column order_commitment type text using order_commitment::text,
  alter column nonce type text using nonce::text;
alter table public.order_authorization_jobs
  add constraint order_authorization_jobs_commitment_decimal_format check (order_commitment ~ '^[0-9]+$'),
  add constraint order_authorization_jobs_nonce_decimal_format check (nonce ~ '^[0-9]+$');
