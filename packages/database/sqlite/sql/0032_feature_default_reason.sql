-- @uniora/sqlite migration 0032_feature_default_reason
-- Generated from src/migrations/0032_feature_default_reason.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Why a feature's default was switched off — same model as `@uniora/postgres`'s `0047_feature_default_reason`:
-- `default_reason` and `default_updated_at` on the feature definition, written by `disableEverywhere` and read back by
-- `listEffective` for the organizations without an override. Nullable and additive.

alter table uniora_feature_definitions add column default_reason text check (default_reason is null or length(default_reason) <= 500);
alter table uniora_feature_definitions add column default_updated_at text;
