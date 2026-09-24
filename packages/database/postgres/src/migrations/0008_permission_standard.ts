/**
 * Permission creation standard (roadmap V1.x — investigated against
 * Clerk's custom Permissions, which take Name + Key + Description, key
 * format `org:<feature>:<permission>` — and Better Auth, whose
 * permissions are statically declared in code as `{ resource: [actions] }`
 * statements, with no dynamic registration API at all).
 *
 * Unlike Organization's slug, Role's key or Feature's key, a permission
 * key is never derived from `name` — it's what a developer writes
 * directly into `can({ permission: "..." })`, so Core only ever
 * validates and rejects it (`assertValidPermissionKey`), never
 * transforms it (uniora-security-engineering §9, "Permission Naming":
 * never silently normalize a security-sensitive identifier in ways that
 * could cause collisions).
 *
 * This migration adds the optional `name` column and backs the
 * "resource.action" format with a real `check` constraint — defense in
 * depth (skill §20): `PermissionRepository.register()` already validates
 * this in `@uniora/core` before the row is ever written, so this
 * constraint should never actually fire in normal operation.
 *
 * As with the FK added in migration 0007, Postgres has no
 * `add constraint if not exists`, so idempotency is done with a
 * `pg_constraint` existence check.
 */
export const MIGRATION_0008_PERMISSION_STANDARD = `
alter table uniora.permissions add column if not exists name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_key_format'
  ) then
    alter table uniora.permissions
      add constraint permissions_key_format check (key ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$');
  end if;
end $$;
`;
