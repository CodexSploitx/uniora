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
    where schemaname = 'uniora' and tablename not in ('audit_logs', 'audit_log_checkpoints', 'schema_migrations')
  loop
    execute format('grant select, insert, update, delete on uniora.%I to uniora_app', t);
  end loop;
end $$;

-- Audit trail: read and append only. No UPDATE, no DELETE, no TRUNCATE.
grant select, insert on uniora.audit_logs to uniora_app;
-- Retention checkpoints: read-only for the app. `uniora.prune_audit_logs` (the only way to delete audit rows) is
-- NOT granted to uniora_app; give it to the role of your retention job instead.
grant select on uniora.audit_log_checkpoints to uniora_app;

-- The migration ledger is read-only for the app (`doctor` reads it; only the migrator writes it).
grant select on uniora.schema_migrations to uniora_app;

-- Sequences used by inserts (e.g. the audit chain position).
grant usage, select on all sequences in schema uniora to uniora_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Platform scope (optional; only if you use the platform administrators, see guides/platform.md)
--
-- The platform tables live in their OWN schema, `uniora_platform`. uniora_app is deliberately given NO access to it: the code
-- that serves organizations cannot read or change who administers the platform, even if it is compromised. Give the platform
-- schema to a separate role that only your platform admin service connects as (and build `createPostgresPlatformStorage` over
-- its own pool). Run this after `uniora migrate` (migration 0037), as uniora_migrator or a superuser.
--
--   create role uniora_platform_app login password '...' nosuperuser nocreaterole nocreatedb;
-- ---------------------------------------------------------------------------------------------------------------------
--
-- grant usage on schema uniora_platform to uniora_platform_app;
-- grant select, insert, update, delete on all tables in schema uniora_platform to uniora_platform_app;
--
-- -- Platform changes are audited in the main audit log (global entries), in the same transaction:
-- grant usage on schema uniora to uniora_platform_app;
-- grant select, insert on uniora.audit_logs to uniora_platform_app;
-- grant usage, select on all sequences in schema uniora to uniora_platform_app;
--
-- -- And make sure the organization role can NOT reach it:
-- revoke all on schema uniora_platform from uniora_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- API credentials (optional; only if you run the UNIORA API server, see design/0001-uniora-server.md)
--
-- API clients and their keys live in their OWN schema, `uniora_api` (migration 0043). Two different roles need two different
-- powers, and uniora_app (the code that serves organizations) needs NONE:
--   uniora_api_server   what the API server connects as to AUTHENTICATE requests. It can READ clients and keys and refresh a
--                       key's `last_used_at`, and nothing else: a compromised server cannot mint, widen or un-revoke a key.
--   uniora_api_admin    what Studio and the CLI connect as to manage clients and keys. Full DML on the schema, plus append to
--                       the audit log (every change is audited in the same transaction).
-- Run after `uniora migrate`, as uniora_migrator or a superuser.
--
--   create role uniora_api_server login password '...' nosuperuser nocreaterole nocreatedb;
--   create role uniora_api_admin  login password '...' nosuperuser nocreaterole nocreatedb;
-- ---------------------------------------------------------------------------------------------------------------------

-- grant usage on schema uniora_api to uniora_api_server, uniora_api_admin;
--
-- -- The server: read-only, plus the one column it keeps current.
-- grant select on uniora_api.clients, uniora_api.keys to uniora_api_server;
-- grant update (last_used_at) on uniora_api.keys to uniora_api_server;
--
-- -- Studio / CLI: manage credentials, and write the audit entries that go with each change.
-- grant select, insert, update on uniora_api.clients, uniora_api.keys to uniora_api_admin;
-- grant usage on schema uniora to uniora_api_admin;
-- grant select, insert on uniora.audit_logs to uniora_api_admin;
-- grant select on uniora.audit_log_checkpoints to uniora_api_admin;
-- grant usage, select on all sequences in schema uniora to uniora_api_admin;
--
-- -- And make sure the organization role can NOT reach credentials:
-- revoke all on schema uniora_api from uniora_app;
