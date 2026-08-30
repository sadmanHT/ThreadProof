-- Project any already-indexed verifier provenance events through the projection trigger.
-- This is intentionally a no-op data update so chain_events remain unchanged.
update public.chain_events
set observed_at = observed_at
where event_name = 'VerifierProvenanceRegistered';
