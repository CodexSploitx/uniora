-- @uniora/postgres migration 0042_policy_kinds
-- Generated from src/migrations/0042_policy_kinds.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- The policy kinds `contextual` (conditions on the time and on request signals) and `sensitive` (conditions on how strongly the
-- person authenticated) join `access`, `resource`, `scope` and `feature`.
--
-- Only the allowed values of `kind` change; no row is touched. The check on `kind` (the definition's `kind` must equal the column)
-- stays as it was. The definition language decides which kinds a release accepts: the schema accepts both new names together so
-- that the release that adds the second one needs no new migration.

alter table uniora.policies drop constraint if exists policies_kind_check;
alter table uniora.policies add constraint policies_kind_check
  check (kind in ('access', 'resource', 'scope', 'feature', 'contextual', 'sensitive'));
