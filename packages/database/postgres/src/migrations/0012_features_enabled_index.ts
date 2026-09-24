/**
 * Supports the per-feature usage queries behind Studio's `/features` page
 * (`FeatureRepository.summarizeUsage`) and `FeatureRepository.unregister`'s
 * "is it still enabled anywhere?" check. `uniora.features`' primary key is
 * `(organization_id, key)`, which can't serve a lookup by `key` alone — the
 * table has one row per (organization, feature), so without this it would be
 * scanned in full for every page. Partial (`where enabled`) because only
 * enabled rows are ever counted/sampled, which also keeps it small;
 * `organization_id` as the second column returns each key's organizations
 * already ordered for the stable sample.
 */
export const MIGRATION_0012_FEATURES_ENABLED_INDEX = `
create index if not exists features_key_enabled_idx
  on uniora.features (key, organization_id) where enabled;
`;
