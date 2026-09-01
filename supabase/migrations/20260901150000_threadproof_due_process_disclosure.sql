create table if not exists public.protected_identity_disclosures (
  id uuid primary key default gen_random_uuid(),
  encrypted_supplier_identity_id uuid not null references public.encrypted_supplier_identities(id) on delete restrict,
  chain_proposal_id text not null unique,
  subject_reference text not null,
  evidence_hash text not null,
  action_hash text not null,
  status text not null default 'staged' check (status in ('staged','authorized','released','quarantined')),
  authorized_tx_hash text,
  authorized_block_number bigint,
  authorized_at timestamptz,
  released_at timestamptz,
  recipient_key_fingerprint text,
  package_sha256 text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint protected_identity_disclosures_proposal_format check (chain_proposal_id ~ '^0x[0-9a-fA-F]{64}$'),
  constraint protected_identity_disclosures_subject_format check (subject_reference ~ '^0x[0-9a-fA-F]{64}$'),
  constraint protected_identity_disclosures_evidence_format check (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint protected_identity_disclosures_action_format check (action_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint protected_identity_disclosures_tx_format check (authorized_tx_hash is null or authorized_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  constraint protected_identity_disclosures_recipient_fingerprint_format check (recipient_key_fingerprint is null or recipient_key_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint protected_identity_disclosures_package_sha256_format check (package_sha256 is null or package_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists protected_identity_disclosures_status_idx
  on public.protected_identity_disclosures(status, created_at);

alter table public.protected_identity_disclosures enable row level security;
revoke all on table public.protected_identity_disclosures from public, anon, authenticated;
grant select, insert, update on table public.protected_identity_disclosures to service_role;

create or replace function private.apply_protected_identity_disclosure_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  staged public.protected_identity_disclosures%rowtype;
  proposal public.governance_proposal_read_model%rowtype;
  proposal_id text;
  subject_reference text;
  evidence_hash text;
begin
  if new.event_name <> 'ProtectedIdentityDisclosureAuthorized' then
    return new;
  end if;

  proposal_id := new.data ->> 'proposalId';
  subject_reference := new.data ->> 'subjectReference';
  evidence_hash := new.data ->> 'evidenceHash';

  if proposal_id is null or proposal_id !~ '^0x[0-9a-fA-F]{64}$'
     or subject_reference is null or subject_reference !~ '^0x[0-9a-fA-F]{64}$'
     or evidence_hash is null or evidence_hash !~ '^0x[0-9a-fA-F]{64}$'
  then
    raise warning 'ProtectedIdentityDisclosureAuthorized event % has invalid identifiers; no disclosure released', new.transaction_hash;
    return new;
  end if;

  select d.* into staged
  from public.protected_identity_disclosures d
  where lower(d.chain_proposal_id) = lower(proposal_id)
  for update;

  if staged.id is null then
    raise warning 'ProtectedIdentityDisclosureAuthorized % has no staged disclosure package', proposal_id;
    return new;
  end if;

  if lower(staged.subject_reference) <> lower(subject_reference)
     or lower(staged.evidence_hash) <> lower(evidence_hash)
  then
    update public.protected_identity_disclosures
    set status = 'quarantined',
        error_code = 'CANONICAL_DISCLOSURE_MISMATCH',
        error_detail = 'Canonical disclosure event did not match the staged subject reference and evidence hash.',
        updated_at = now()
    where id = staged.id;
    return new;
  end if;

  select g.* into proposal
  from public.governance_proposal_read_model g
  where lower(g.chain_proposal_id) = lower(proposal_id);

  if proposal.chain_proposal_id is null
     or proposal.proposal_type <> 'protected_identity_disclosure'
     or lower(coalesce(proposal.action_hash, '')) <> lower(staged.action_hash)
  then
    update public.protected_identity_disclosures
    set status = 'quarantined',
        error_code = 'GOVERNANCE_ACTION_MISMATCH',
        error_detail = 'Canonical disclosure event was not bound to the staged protected-identity governance action hash.',
        updated_at = now()
    where id = staged.id;
    return new;
  end if;

  update public.protected_identity_disclosures
  set status = 'authorized',
      authorized_tx_hash = new.transaction_hash,
      authorized_block_number = new.block_number,
      authorized_at = coalesce(new.observed_at, now()),
      error_code = null,
      error_detail = null,
      updated_at = now()
  where id = staged.id
    and status in ('staged','authorized');

  return new;
end;
$$;

revoke all on function private.apply_protected_identity_disclosure_event() from public, anon, authenticated;
grant execute on function private.apply_protected_identity_disclosure_event() to service_role;

drop trigger if exists threadproof_protected_identity_disclosure_event on public.chain_events;
create trigger threadproof_protected_identity_disclosure_event
after insert or update of data, event_name, transaction_hash, block_number, observed_at
on public.chain_events
for each row
execute function private.apply_protected_identity_disclosure_event();

update public.chain_events
set observed_at = observed_at
where event_name = 'ProtectedIdentityDisclosureAuthorized';

comment on table public.protected_identity_disclosures is
'Service-only due-process receipts. A package becomes authorized only from the exact canonical ThreadProofCharter ProtectedIdentityDisclosureAuthorized event and matching proposal action hash.';
