/**
 * Role keys (roadmap V1.x — Custom Role creation standard, researched
 * against Clerk's `org:<role>` role keys and Better Auth's `createRole`).
 * Mirrors the Organization slug standard (migration 0005): every role
 * gets a stable, URL-safe `key` alongside its opaque `id`, unique within
 * its organization — never globally, since roles are already scoped to
 * one organization, unlike Organization slugs.
 *
 * `name` keeps its existing (organization_id, name) uniqueness from
 * migration 0004 — this migration adds `key` uniqueness as an
 * additional, independent guarantee, it does not replace it. "owner" is
 * reserved for the protected Owner role at the application layer
 * (`role/key.ts`), so every existing Owner role backfills to `key =
 * 'owner'` here.
 *
 * Backfills any pre-existing row before enforcing `not null` +
 * uniqueness, same pattern as migration 0005 — and for the same reason,
 * the backfill derives `key` from `id` rather than `name`: `id` is
 * globally unique (so unique within any single org too), while `name`'s
 * pre-existing uniqueness (migration 0004) is an exact, case-sensitive
 * string match. Two pre-existing roles in the same org whose `name`
 * differs only by case/punctuation (e.g. "Sales Manager" vs
 * "sales manager") would normalize to the same `key` and make the
 * `create unique index roles_org_key_key` below fail — deriving from
 * `id` instead makes that collision impossible, mirroring exactly why
 * migration 0005 backfills the Organization slug from `id`, not `name`.
 */
export const MIGRATION_0006_ROLE_KEY = `
alter table uniora.roles add column if not exists key text;

update uniora.roles
set key = case
  when is_owner_role then 'owner'
  else lower(regexp_replace(id, '[^a-zA-Z0-9]+', '-', 'g'))
end
where key is null;

alter table uniora.roles alter column key set not null;

create unique index if not exists roles_org_key_key on uniora.roles (organization_id, key);
`;
