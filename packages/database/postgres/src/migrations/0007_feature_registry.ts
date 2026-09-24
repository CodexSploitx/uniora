/**
 * Feature registry (roadmap V1.x — Feature creation standard, researched
 * against Clerk's Billing Features (`slug` + `name`, scoped to a Plan) —
 * Better Auth has no equivalent built-in concept (entitlements are still
 * an open feature request there, handled via third-party plugins).
 *
 * Closes the gap documented since Custom Roles: `FeatureRepository` had
 * no catalog at all — `enable`/`disable` accepted any string `key`
 * without validating it against anything, unlike Permissions (which
 * require `register()` first, backed by a real FK).
 *
 * `uniora.feature_definitions` is the global catalog (like
 * `uniora.permissions`, unlike `uniora.roles` which is per-organization —
 * a feature is a definition the whole app shares, not scoped to one
 * tenant). Backfills one row per distinct pre-existing `key` in
 * `uniora.features` (using the key as a placeholder `name`, since no
 * real name exists for legacy data) before adding the FK, same
 * backfill-before-constrain pattern as migrations 0005/0006.
 */
export const MIGRATION_0007_FEATURE_REGISTRY = `
create table if not exists uniora.feature_definitions (
  key text primary key,
  name text not null,
  description text
);

insert into uniora.feature_definitions (key, name)
select distinct key, key from uniora.features
on conflict (key) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'features_key_fkey'
  ) then
    alter table uniora.features
      add constraint features_key_fkey foreign key (key) references uniora.feature_definitions(key) on delete cascade;
  end if;
end $$;
`;
