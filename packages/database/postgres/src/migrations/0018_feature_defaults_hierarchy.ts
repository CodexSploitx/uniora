/**
 * Feature defaults, hierarchy and change metadata.
 *
 * - `default_enabled`: what an organization WITHOUT a row in `uniora.features` gets. `false` for every
 *   pre-existing definition keeps the historical "no row = off" behaviour exactly.
 * - `parent_key`: a feature is effectively on only while its parent is too. `on delete restrict` — a parent
 *   with children cannot be removed by accident (the repository reports it as `feature_has_children`).
 *   A feature cannot be its own parent; longer cycles and the maximum depth are rejected by `register()`.
 * - `updated_at`, `updated_by_*`, `reason` on the per-organization override: when, who and why it last
 *   changed. Nullable — rows written before this migration simply have no history.
 */
export const MIGRATION_0018_FEATURE_DEFAULTS_HIERARCHY = `
alter table uniora.feature_definitions
  add column if not exists default_enabled boolean not null default false,
  add column if not exists parent_key text references uniora.feature_definitions(key) on delete restrict;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feature_definitions_parent_not_self') then
    alter table uniora.feature_definitions
      add constraint feature_definitions_parent_not_self check (parent_key is null or parent_key <> key);
  end if;
end $$;

create index if not exists feature_definitions_parent_idx on uniora.feature_definitions (parent_key) where parent_key is not null;

alter table uniora.features
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by_provider text,
  add column if not exists updated_by_subject text,
  add column if not exists reason text check (reason is null or length(reason) <= 500);
`;
