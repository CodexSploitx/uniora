/**
 * Feature defaults, hierarchy and change metadata — same model as `@uniora/postgres`'s
 * `0018_feature_defaults_hierarchy`.
 *
 * - `default_enabled`: what an organization WITHOUT a row in `uniora_features` gets (0 keeps the historical
 *   "no row = off" behaviour for every pre-existing definition).
 * - `parent_key`: a feature is effectively on only while its parent is too; `on delete restrict` so a parent with
 *   children can't be removed by accident. Cycles and depth are rejected by `register()`.
 * - `updated_at`, `updated_by_*`, `reason` on the per-organization override: when, who and why it last changed.
 */
export const MIGRATION_0004_FEATURE_DEFAULTS_HIERARCHY = `
alter table uniora_feature_definitions add column default_enabled integer not null default 0 check (default_enabled in (0, 1));
alter table uniora_feature_definitions add column parent_key text references uniora_feature_definitions (key) on delete restrict;
create index if not exists uniora_feature_definitions_parent_idx on uniora_feature_definitions (parent_key) where parent_key is not null;

alter table uniora_features add column updated_at text;
alter table uniora_features add column updated_by_provider text;
alter table uniora_features add column updated_by_subject text;
alter table uniora_features add column reason text check (reason is null or length(reason) <= 500);
`;
