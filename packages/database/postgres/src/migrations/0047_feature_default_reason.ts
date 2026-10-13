/**
 * Why a feature's default was switched off: `default_reason` and `default_updated_at` on the feature definition, written by
 * `disableEverywhere` (the kill switch) and read back by `listEffective` for the organizations without an override, so an
 * application can tell each of them why the feature is unavailable without reading the audit log.
 *
 * Nullable and additive: a definition that was never killed (or was killed before this migration) simply has neither.
 */
export const MIGRATION_0047_FEATURE_DEFAULT_REASON = `
alter table uniora.feature_definitions
  add column if not exists default_reason text check (default_reason is null or length(default_reason) <= 500),
  add column if not exists default_updated_at timestamptz(3);
`;
