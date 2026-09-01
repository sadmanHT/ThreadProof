-- Sanitized operational visibility for the rebuildable blockchain indexer.
-- The cursor remains non-canonical operational state; the consortium chain is authoritative.

create or replace function public.get_chain_indexer_health()
returns table (
  chain_id bigint,
  last_block_number bigint,
  last_block_hash text,
  status text,
  error_code text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.organization_members membership
    where membership.user_id = auth.uid()
      and membership.active = true
  ) then
    raise exception 'An active consortium membership is required.' using errcode = '42501';
  end if;

  return query
  select
    cursor.chain_id,
    cursor.last_block_number,
    cursor.last_block_hash,
    cursor.status::text,
    cursor.error_code,
    cursor.updated_at
  from public.chain_indexer_cursors cursor
  order by cursor.chain_id;
end;
$$;

revoke all on function public.get_chain_indexer_health() from public;
revoke all on function public.get_chain_indexer_health() from anon;
grant execute on function public.get_chain_indexer_health() to authenticated;

comment on function public.get_chain_indexer_health() is
'Returns sanitized rebuildable indexer progress to authenticated consortium members. It intentionally omits error_detail and never establishes protocol authority; canonical state must be verified against the consortium RPC.';
