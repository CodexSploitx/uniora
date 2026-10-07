/**
 * Optimistic concurrency: `version` on organizations and roles. It starts at 1 and the library adds one on every change,
 * so `update(..., { expectedVersion })` / `setPermissions(..., { expectedVersion })` can refuse an edit made from a stale
 * copy (`organization_version_conflict`, `role_version_conflict`) instead of overwriting a newer one. Existing rows start
 * at 1; callers that never pass `expectedVersion` behave exactly as before.
 */
export const MIGRATION_0030_ROW_VERSIONS = `
alter table uniora.organizations add column if not exists version integer not null default 1 check (version >= 1);
alter table uniora.roles add column if not exists version integer not null default 1 check (version >= 1);
`;
