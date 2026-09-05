-- validated_buyer_signer is worker-derived evidence, never browser-authored authority.
-- Keep browser sessions read-only for this column; service-role relayers retain update.

revoke update (validated_buyer_signer)
  on public.order_authorization_jobs
  from authenticated;
revoke update (validated_buyer_signer)
  on public.order_cancellation_jobs
  from authenticated;

grant update (validated_buyer_signer)
  on public.order_authorization_jobs
  to service_role;
grant update (validated_buyer_signer)
  on public.order_cancellation_jobs
  to service_role;

comment on column public.order_authorization_jobs.validated_buyer_signer is
'Worker-derived EIP-712 signer recovered against the runtime OrderRegistry domain and validated as an active buyer-organization account. Browser sessions cannot write this field.';
comment on column public.order_cancellation_jobs.validated_buyer_signer is
'Worker-derived EIP-712 cancellation signer recovered against the runtime OrderRegistry domain and validated as an active buyer-organization account. Browser sessions cannot write this field.';
