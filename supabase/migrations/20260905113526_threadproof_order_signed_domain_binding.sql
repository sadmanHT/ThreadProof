alter table public.order_authorization_jobs
  add column signed_chain_id bigint,
  add column signed_order_registry_address text,
  add column signed_typed_data_hash text,
  add column validated_buyer_signer text;

alter table public.order_cancellation_jobs
  add column signed_chain_id bigint,
  add column signed_order_registry_address text,
  add column signed_typed_data_hash text,
  add column validated_buyer_signer text;

alter table public.order_authorization_jobs
  add constraint order_authorization_jobs_signed_chain_id_check check (signed_chain_id is null or signed_chain_id > 0),
  add constraint order_authorization_jobs_signed_registry_check check (signed_order_registry_address is null or signed_order_registry_address ~ '^0x[0-9a-fA-F]{40}$'),
  add constraint order_authorization_jobs_signed_digest_check check (signed_typed_data_hash is null or signed_typed_data_hash ~ '^0x[0-9a-fA-F]{64}$'),
  add constraint order_authorization_jobs_validated_signer_check check (validated_buyer_signer is null or validated_buyer_signer ~ '^0x[0-9a-fA-F]{40}$');

alter table public.order_cancellation_jobs
  add constraint order_cancellation_jobs_signed_chain_id_check check (signed_chain_id is null or signed_chain_id > 0),
  add constraint order_cancellation_jobs_signed_registry_check check (signed_order_registry_address is null or signed_order_registry_address ~ '^0x[0-9a-fA-F]{40}$'),
  add constraint order_cancellation_jobs_signed_digest_check check (signed_typed_data_hash is null or signed_typed_data_hash ~ '^0x[0-9a-fA-F]{64}$'),
  add constraint order_cancellation_jobs_validated_signer_check check (validated_buyer_signer is null or validated_buyer_signer ~ '^0x[0-9a-fA-F]{40}$');

grant select (signed_chain_id, signed_order_registry_address, signed_typed_data_hash, validated_buyer_signer) on public.order_authorization_jobs to authenticated;
grant insert (signed_chain_id, signed_order_registry_address, signed_typed_data_hash) on public.order_authorization_jobs to authenticated;
grant update (validated_buyer_signer) on public.order_authorization_jobs to authenticated;

grant select (signed_chain_id, signed_order_registry_address, signed_typed_data_hash, validated_buyer_signer) on public.order_cancellation_jobs to authenticated;
grant insert (signed_chain_id, signed_order_registry_address, signed_typed_data_hash) on public.order_cancellation_jobs to authenticated;
grant update (validated_buyer_signer) on public.order_cancellation_jobs to authenticated;

grant select, update on public.order_authorization_jobs to service_role;
grant select, update on public.order_cancellation_jobs to service_role;

comment on column public.order_authorization_jobs.signed_typed_data_hash is 'Exact EIP-712 digest prepared by the web boundary; relayers must recompute and match it before broadcast.';
comment on column public.order_cancellation_jobs.signed_typed_data_hash is 'Exact EIP-712 cancellation digest prepared by the web boundary; relayers must recompute and match it before broadcast.';
