-- @uniora/sqlite migration 0018_membership_feature_versions
-- Generated from src/migrations/0018_membership_feature_versions.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Optimistic concurrency, continued from `0015_row_versions` — same model as `@uniora/postgres`'s
-- `0033_membership_feature_versions`: `version` on memberships and on feature overrides, starting at 1, plus one on
-- every explicit change, so `expectedVersion` can refuse an edit made from a stale copy.

alter table uniora_memberships add column version integer not null default 1 check (version >= 1);
alter table uniora_features add column version integer not null default 1 check (version >= 1);
