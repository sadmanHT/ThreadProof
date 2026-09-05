create or replace function threadproof_e2e_private.reap_orphan_browser_chain_cursor_impl(
  target_chain_id bigint,
  expected_cursor_block bigint,
  expected_cursor_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_block bigint;
  cursor_hash text;
  cursor_updated_at timestamptz;
  cursor_exists boolean;
  event_count bigint;
  provenance_count bigint;
  stale_cutoff timestamptz := statement_timestamp() - interval '10 minutes';
begin
  if target_chain_id <> 2026 then
    raise exception 'browser-chain orphan cursor recovery is restricted to ThreadProof chain 2026';
  end if;
  if expected_cursor_block is null or expected_cursor_hash is null then
    raise exception 'expected cursor block/hash are required';
  end if;
  if expected_cursor_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'expected cursor hash must be a 32-byte hex value';
  end if;

  lock table public.chain_events in share row exclusive mode;
  lock table public.chain_indexer_cursors in share row exclusive mode;
  lock table public.verifier_provenance_read_model in share row exclusive mode;
  lock table public.worker_runtime_heartbeats in share mode;

  select count(*) into event_count
  from public.chain_events
  where chain_id = target_chain_id;

  select count(*) into provenance_count
  from public.verifier_provenance_read_model
  where chain_id = target_chain_id;

  if event_count <> 0 or provenance_count <> 0 then
    raise exception 'orphan cursor recovery requires zero chain events and zero verifier provenance rows';
  end if;

  select last_block_number, last_block_hash, updated_at
    into cursor_block, cursor_hash, cursor_updated_at
  from public.chain_indexer_cursors
  where chain_id = target_chain_id;
  cursor_exists := found;

  if not cursor_exists then
    return false;
  end if;

  if cursor_block <> expected_cursor_block or lower(cursor_hash) <> lower(expected_cursor_hash) then
    raise exception 'indexer cursor changed during orphan recovery';
  end if;

  if cursor_updated_at >= stale_cutoff then
    raise exception 'indexer cursor is not stale enough for orphan recovery';
  end if;

  if exists (
    select 1
    from public.worker_runtime_heartbeats
    where chain_id = target_chain_id
      and worker_type = 'indexer'
      and last_heartbeat_at >= stale_cutoff
  ) then
    raise exception 'fresh indexer heartbeat prevents orphan cursor recovery';
  end if;

  delete from public.chain_indexer_cursors
  where chain_id = target_chain_id
    and last_block_number = expected_cursor_block
    and lower(last_block_hash) = lower(expected_cursor_hash);

  if not found then
    raise exception 'indexer cursor disappeared during orphan recovery';
  end if;

  return true;
end;
$$;

revoke all on function threadproof_e2e_private.reap_orphan_browser_chain_cursor_impl(bigint,bigint,text) from public, anon, authenticated;
grant execute on function threadproof_e2e_private.reap_orphan_browser_chain_cursor_impl(bigint,bigint,text) to service_role;

create or replace function public.reap_orphan_browser_chain_e2e_cursor(
  target_chain_id bigint,
  expected_cursor_block bigint,
  expected_cursor_hash text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return threadproof_e2e_private.reap_orphan_browser_chain_cursor_impl(
    target_chain_id,
    expected_cursor_block,
    expected_cursor_hash
  );
end;
$$;

revoke all on function public.reap_orphan_browser_chain_e2e_cursor(bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.reap_orphan_browser_chain_e2e_cursor(bigint,bigint,text) to service_role;

comment on function public.reap_orphan_browser_chain_e2e_cursor(bigint,bigint,text) is
'Test-only recovery gate for a stale chain-2026 cursor left by interrupted browser-to-chain runs. It may delete only an unchanged cursor older than ten minutes when chain events and verifier provenance are empty and no chain-2026 indexer heartbeat is fresh within ten minutes.';