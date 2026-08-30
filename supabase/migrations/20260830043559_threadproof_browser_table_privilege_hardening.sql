-- RLS governs row DML but does not protect table-maintenance operations such as TRUNCATE.
-- Browser roles do not need these privileges on ThreadProof application tables.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- Prevent future postgres-owned public tables from inheriting the same browser maintenance privileges.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;
