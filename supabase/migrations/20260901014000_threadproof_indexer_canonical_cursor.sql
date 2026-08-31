-- Operational cursor for the rebuildable blockchain read-model indexer.
-- This table never makes Postgres authoritative for protocol state. It records the
-- last confirmed block/hash the worker projected so canonicality drift can fail closed.

create type public.chain_indexer_cursor_status as enum ('healthy', 'reorg_detected');

create table public.chain_indexer_cursors (
  chain_id bigint primary key,
  last_block_number bigint not null check (last_block_number >= 0),
  last_block_hash text not null check (last_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  status public.chain_indexer_cursor_status not null default 'healthy',
  error_code text,
  error_detail text,
  updated_at timestamptz not null default now(),
  check (
    (status = 'healthy' and error_code is null and error_detail is null)
    or status = 'reorg_detected'
  )
);

alter table public.chain_indexer_cursors enable row level security;

-- Existing deployments already have a rebuildable event mirror. Seed the operational
-- cursor from the latest mirrored event per chain to avoid replaying from block zero.
-- The worker MUST verify this stored hash against canonical RPC before advancing it.
insert into public.chain_indexer_cursors (
  chain_id,
  last_block_number,
  last_block_hash,
  status,
  updated_at
)
select distinct on (ce.chain_id)
  ce.chain_id,
  ce.block_number,
  ce.block_hash,
  'healthy'::public.chain_indexer_cursor_status,
  now()
from public.chain_events ce
order by ce.chain_id, ce.block_number desc, ce.log_index desc;

-- Browser/authenticated clients must never mutate or use the cursor as protocol truth.
revoke all on table public.chain_indexer_cursors from public, anon, authenticated;
grant select, insert, update on table public.chain_indexer_cursors to service_role;

comment on table public.chain_indexer_cursors is
'Operational indexer progress and block-hash guard. Rebuildable and non-canonical; blockchain state remains authoritative.';
comment on column public.chain_indexer_cursors.last_block_hash is
'Hash of the last confirmation-adjusted block whose protocol events were projected. Verified against the canonical RPC before advancing.';
