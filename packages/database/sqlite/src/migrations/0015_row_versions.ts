/**
 * Optimistic concurrency — same model as `@uniora/postgres`'s `0030_row_versions`: `version` on organizations and
 * roles, starting at 1, plus one on every change, so `expectedVersion` can refuse an edit made from a stale copy.
 */
export const MIGRATION_0015_ROW_VERSIONS = `
alter table uniora_organizations add column version integer not null default 1 check (version >= 1);
alter table uniora_roles add column version integer not null default 1 check (version >= 1);
`;
