create index if not exists order_cancellation_jobs_created_by_idx
  on public.order_cancellation_jobs(created_by, created_at desc);
