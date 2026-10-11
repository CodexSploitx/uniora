-- @uniora/postgres migration 0033_membership_feature_versions
-- Generated from src/migrations/0033_membership_feature_versions.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Optimistic concurrency, continued from `0030_row_versions`: `version` on memberships and on feature overrides. It
-- starts at 1 and the library adds one on every explicit change (a role assigned or removed, block / suspend /
-- unblock; an override written), so `expectedVersion` can refuse an edit made from a stale copy
-- (`membership_version_conflict`, `feature_version_conflict`). Existing rows start at 1; callers that never pass
-- `expectedVersion` behave exactly as before.

alter table uniora.memberships add column if not exists version integer not null default 1 check (version >= 1);
alter table uniora.features add column if not exists version integer not null default 1 check (version >= 1);
