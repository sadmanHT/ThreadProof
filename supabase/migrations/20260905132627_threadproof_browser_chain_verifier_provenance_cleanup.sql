-- Keep disposable browser-to-chain projection cleanup complete across all derived
-- chain-2026 read models. Verifier provenance is informational/rebuildable; canonical
-- verifier authority remains on CapacityVault.

create or replace function threadproof_e2e_private.cleanup_browser_chain_projection_impl(
  target_chain_id bigint,
  expected_event_count bigint,
  expected_cursor_block bigint,
  expected_cursor_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_event_count bigint;
  actual_cursor_block bigint;
  actual_cursor_hash text;
  cursor_exists boolean;
begin
  if target_chain_id <> 2026 then
    raise exception 'browser-chain cleanup is restricted to ThreadProof chain 2026';
  end if;
  if expected_event_count is null or expected_event_count < 0 then
    raise exception 'expected event count must be non-negative';
  end if;
  if (expected_cursor_block is null) <> (expected_cursor_hash is null) then
    raise exception 'expected cursor block/hash must both be null or both be supplied';
  end if;

  lock table public.chain_events in share row exclusive mode;
  lock table public.chain_indexer_cursors in share row exclusive mode;
  lock table public.verifier_provenance_read_model in share row exclusive mode;

  select count(*) into actual_event_count
  from public.chain_events
  where chain_id = target_chain_id;

  if actual_event_count <> expected_event_count then
    raise exception 'chain event count changed during verified cleanup: expected %, found %', expected_event_count, actual_event_count;
  end if;

  select last_block_number, last_block_hash
    into actual_cursor_block, actual_cursor_hash
  from public.chain_indexer_cursors
  where chain_id = target_chain_id;
  cursor_exists := found;

  if expected_cursor_block is null then
    if cursor_exists then
      raise exception 'indexer cursor appeared during verified cleanup';
    end if;
  else
    if not cursor_exists then
      raise exception 'expected indexer cursor disappeared during verified cleanup';
    end if;
    if actual_cursor_block <> expected_cursor_block
       or lower(actual_cursor_hash) <> lower(expected_cursor_hash) then
      raise exception 'indexer cursor changed during verified cleanup';
    end if;
  end if;

  delete from public.chain_events where chain_id = target_chain_id;
  delete from public.chain_indexer_cursors where chain_id = target_chain_id;
  delete from public.verifier_provenance_read_model where chain_id = target_chain_id;
end;
$$;

comment on function public.cleanup_browser_chain_e2e_projection(bigint,bigint,bigint,text) is
'Test-only serialized cleanup gate for a browser-to-chain disposable chain-2026 projection. The caller must first verify every persisted block hash against the disposable RPC when canonical events/cursor exist; the implementation rechecks count/cursor under locks and removes the derived verifier-provenance read model with the owned projection.';
