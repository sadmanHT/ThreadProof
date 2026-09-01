-- Sanitized operational visibility for the rebuildable blockchain indexer.
-- The cursor remains non-canonical operational state; the consortium chain is authoritative.

grant select (
  chain_id,
  last_block_number,
  last_block_hash,
  status,
  error_code,
  updated_at
) on table public.chain_indexer_cursors to authenticated;

create policy chain_indexer_cursors_consortium_read on public.chain_indexer_cursors
  for select to authenticated
  using ((select private.is_consortium_member()));

create or replace function public.get_chain_indexer_health()
returns table (
  chain_id bigint,
  last_block_number bigint,
  last_block_hash text,
  status text,
  error_code text,
  updated_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    cursor.chain_id,
    cursor.last_block_number,
    cursor.last_block_hash,
    cursor.status::text,
    cursor.error_code,
    cursor.updated_at
  from public.chain_indexer_cursors cursor
  order by cursor.chain_id;
$$;

revoke all on function public.get_chain_indexer_health() from public;
revoke all on function public.get_chain_indexer_health() from anon;
grant execute on function public.get_chain_indexer_health() to authenticated;

comment on function public.get_chain_indexer_health() is
'Returns sanitized rebuildable indexer progress through caller privileges and RLS. It intentionally omits error_detail and never establishes protocol authority; canonical state must be verified against the consortium RPC.';
