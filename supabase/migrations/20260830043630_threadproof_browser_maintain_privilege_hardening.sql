-- PostgreSQL 17 MAINTAIN is a table-maintenance privilege and is not part of row-level DML authorization.
revoke maintain on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke maintain on tables from anon, authenticated;
