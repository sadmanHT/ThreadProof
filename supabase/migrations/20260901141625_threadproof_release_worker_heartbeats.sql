alter table public.worker_runtime_heartbeats
  drop constraint if exists worker_runtime_heartbeats_worker_type_check;

alter table public.worker_runtime_heartbeats
  add constraint worker_runtime_heartbeats_worker_type_check
  check (worker_type in (
    'indexer',
    'order_relayer',
    'subcontract_relayer',
    'proof_generator',
    'proof_submitter',
    'capacity_release_generator',
    'capacity_release_submitter'
  ));
