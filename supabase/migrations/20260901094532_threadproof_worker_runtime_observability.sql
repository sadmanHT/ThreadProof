create table public.worker_runtime_heartbeats (
  instance_id uuid primary key,
  worker_type text not null check (worker_type in ('indexer','order_relayer','subcontract_relayer','proof_generator','proof_submitter')),
  status text not null check (status in ('starting','ready','degraded','stopping')),
  chain_id bigint,
  build_commit text,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  last_success_at timestamptz,
  error_code text,
  constraint worker_runtime_build_commit_length check (build_commit is null or char_length(build_commit) <= 64),
  constraint worker_runtime_error_code_format check (error_code is null or error_code ~ '^[A-Z0-9_:-]{1,96}$')
);

create index worker_runtime_heartbeats_type_freshness_idx
  on public.worker_runtime_heartbeats(worker_type, last_heartbeat_at desc);

alter table public.worker_runtime_heartbeats enable row level security;

revoke all on table public.worker_runtime_heartbeats from anon, authenticated;
grant select on table public.worker_runtime_heartbeats to authenticated;
grant all on table public.worker_runtime_heartbeats to service_role;

create policy worker_runtime_heartbeats_consortium_read
  on public.worker_runtime_heartbeats
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.user_id = (select auth.uid())
        and m.active
    )
  );

comment on table public.worker_runtime_heartbeats is
  'Sanitized worker liveness telemetry only. No job identifiers, payloads, RPC URLs, signer configuration, or error detail.';
