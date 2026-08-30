-- Non-authoritative AI audit trail.
-- AI output may summarize/extract/rank information but never overrides canonical Besu state,
-- ZK proof validity, credential status, capacity state, subcontract authorization, or governance execution.

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  task_type text not null check (task_type in ('order_intelligence', 'audit_copilot')),
  model_provider text not null default 'openai' check (model_provider in ('openai', 'other')),
  model_name text not null check (char_length(model_name) between 1 and 128),
  prompt_template_hash text not null check (prompt_template_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_hash text not null check (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_reference_hashes jsonb not null default '[]'::jsonb check (jsonb_typeof(input_reference_hashes) = 'array'),
  subject_type text,
  subject_id text,
  data_class text not null check (data_class in ('consortium_visible', 'counterparty_confidential')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  output_json jsonb,
  provider_response_id text,
  error_code text,
  error_detail text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_runs_completion_consistency check (
    (status = 'running' and completed_at is null)
    or (status in ('completed', 'failed') and completed_at is not null)
  )
);

create table public.ai_findings (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid not null references public.ai_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  subject_type text,
  subject_id text,
  severity text not null check (severity in ('info', 'low', 'medium', 'high')),
  finding_type text not null check (char_length(finding_type) between 1 and 128),
  explanation text not null check (char_length(explanation) between 1 and 4000),
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array'),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'dismissed', 'resolved')),
  created_at timestamptz not null default now()
);

comment on table public.ai_runs is 'Organization-scoped audit records for non-authoritative AI intelligence runs. Inputs are represented by hashes/references; canonical protocol truth remains on Besu.';
comment on table public.ai_findings is 'Reviewable findings derived from AI runs. Findings are advisory and cannot authorize protocol state transitions.';

create index ai_runs_org_created_idx on public.ai_runs(organization_id, created_at desc);
create index ai_runs_created_by_created_idx on public.ai_runs(created_by, created_at desc);
create index ai_runs_task_created_idx on public.ai_runs(task_type, created_at desc);
create index ai_findings_run_idx on public.ai_findings(ai_run_id);
create index ai_findings_org_created_idx on public.ai_findings(organization_id, created_at desc);
create index ai_findings_subject_idx on public.ai_findings(subject_type, subject_id);

alter table public.ai_runs enable row level security;
alter table public.ai_findings enable row level security;

create policy ai_runs_org_read
on public.ai_runs
for select
to authenticated
using (
  organization_id in (
    select organization_id
    from public.organization_members
    where user_id = (select auth.uid()) and active = true
  )
);

create policy ai_findings_org_read
on public.ai_findings
for select
to authenticated
using (
  organization_id in (
    select organization_id
    from public.organization_members
    where user_id = (select auth.uid()) and active = true
  )
);

revoke all on public.ai_runs from anon, authenticated, service_role;
revoke all on public.ai_findings from anon, authenticated, service_role;
grant select on public.ai_runs, public.ai_findings to authenticated;
grant select, insert, update on public.ai_runs, public.ai_findings to service_role;

-- RLS does not protect maintenance privileges; keep these unavailable to browser/service API roles.
revoke truncate, trigger, references, maintain on public.ai_runs, public.ai_findings from anon, authenticated, service_role;
