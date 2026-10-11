-- @uniora/postgres migration 0039_search_indexes
-- Generated from src/migrations/0039_search_indexes.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Substring search at any size. `search({ query })` means "contains, ignoring case" (`ilike '%text%'`), which a B-tree
-- cannot serve: on millions of rows it is a scan. Trigram GIN indexes (`pg_trgm`) answer it from an index, and the planner
-- keeps choosing a plain scan when the term is too common to narrow anything, so no query changes.
--
-- `pg_trgm` ships with PostgreSQL's contrib modules and is a "trusted" extension (PostgreSQL 13+), so the database owner can
-- create it. If this role cannot, the migration still succeeds (searching keeps working, just without the indexes) and says
-- so in a notice; a superuser runs `create extension pg_trgm` and this migration's `create index` statements, which are all
-- idempotent. On a table that already holds millions of rows the indexes take a minute or two to build and block writes
-- to that table meanwhile: apply it in a quiet moment.
--
-- Also: a person's memberships across organizations (`findByIdentity`, the member's "other organizations", every
-- authorization lookup that starts from an identity) filtered on `(provider, subject)`, and nothing led with those columns
-- (the unique key starts with `organization_id`). And `(status, id)`: the cross-organization "blocked members" view had no index to start from.

create index if not exists memberships_identity_idx on uniora.memberships (provider, subject);
create index if not exists memberships_status_idx on uniora.memberships (status, id);

do $$
declare
  trgm_schema text;
begin
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'UNIORA: pg_trgm is not available (%); substring searches will scan. Ask a superuser to run "create extension pg_trgm" and the create index statements of migration 0039.', sqlerrm;
  end;

  select n.nspname into trgm_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if trgm_schema is null then
    return;
  end if;

  execute format('create index if not exists memberships_subject_trgm_idx on uniora.memberships using gin (subject %I.gin_trgm_ops)', trgm_schema);
  execute format('create index if not exists memberships_provider_trgm_idx on uniora.memberships using gin (provider %I.gin_trgm_ops)', trgm_schema);
  execute format('create index if not exists organizations_name_trgm_idx on uniora.organizations using gin (name %I.gin_trgm_ops)', trgm_schema);
  execute format('create index if not exists organizations_slug_trgm_idx on uniora.organizations using gin (slug %I.gin_trgm_ops)', trgm_schema);
  execute format('create index if not exists invitations_email_trgm_idx on uniora.invitations using gin (email %I.gin_trgm_ops)', trgm_schema);
end
$$;
