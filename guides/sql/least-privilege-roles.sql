-- Least-privilege database roles for Uniora on PostgreSQL (security audit F-16).
--
-- Two roles, so the credentials your running application holds can't alter the schema or touch the
-- audit trail:
--   uniora_migrator  owns the `uniora` schema and runs `uniora migrate` (DDL). Use it ONLY from CI/CD
--                    or an operator's shell, never in the application's environment.
--   uniora_app       what the application / Studio / the SDK connect as: data access only. It can read
--                    and write the data tables, but can only READ and APPEND to audit_logs
--                    (the append-only trigger rejects UPDATE/DELETE as well; this is a second layer).
--
-- Run once as a superuser, replacing the passwords, then run `uniora migrate` with the migrator's URL
-- and point DATABASE_URL at uniora_app. Re-run the GRANT section after every migration that adds tables.
--
--   psql "$ADMIN_URL" -v migrator_password="'...'" -v app_password="'...'" -f guides/sql/least-privilege-roles.sql

create role uniora_migrator login password :migrator_password nosuperuser nocreaterole nocreatedb;
create role uniora_app      login password :app_password      nosuperuser nocreaterole nocreatedb;

-- The migrator creates (and therefore owns) the schema and every object in it.
select format('grant create on database %I to uniora_migrator', current_database()) \gexec

-- Everything below runs AFTER the first `uniora migrate` (so the tables exist) and again after each
-- upgrade that adds tables. Run it as uniora_migrator or a superuser.
grant usage on schema uniora to uniora_app;

-- Data tables: full DML. Everything except the audit trail.
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'uniora' and tablename not in ('audit_logs', 'schema_migrations')
  loop
    execute format('grant select, insert, update, delete on uniora.%I to uniora_app', t);
  end loop;
end $$;

-- Audit trail: read and append only. No UPDATE, no DELETE, no TRUNCATE.
grant select, insert on uniora.audit_logs to uniora_app;

-- The migration ledger is read-only for the app (`doctor` reads it; only the migrator writes it).
grant select on uniora.schema_migrations to uniora_app;

-- Sequences used by inserts (e.g. the audit chain position).
grant usage, select on all sequences in schema uniora to uniora_app;
