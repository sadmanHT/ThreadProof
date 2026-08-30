alter table public.ai_runs alter column model_provider set default 'gemini';

alter table public.ai_runs drop constraint if exists ai_runs_model_provider_check;
alter table public.ai_runs add constraint ai_runs_model_provider_check
  check (model_provider in ('gemini', 'openai', 'other'));

comment on column public.ai_runs.model_provider is
  'AI provider used for a non-authoritative intelligence run. Current application default is gemini; this field is audit metadata only.';
