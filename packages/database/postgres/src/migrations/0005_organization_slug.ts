/**
 * Organization slugs (roadmap V1.x — Organization creation standard,
 * researched against Clerk/Better Auth). Every organization gets a
 * URL-safe, globally unique `slug` alongside its opaque `id`.
 *
 * Backfills any pre-existing row before enforcing `not null` + uniqueness,
 * so this stays a safe migration to run against a database that already
 * has organizations (in practice none does yet in this early-stage
 * project, but the migration doesn't assume that).
 */
export const MIGRATION_0005_ORGANIZATION_SLUG = `
alter table uniora.organizations add column if not exists slug text;

update uniora.organizations
set slug = lower(regexp_replace(id, '[^a-zA-Z0-9]+', '-', 'g'))
where slug is null;

alter table uniora.organizations alter column slug set not null;

create unique index if not exists organizations_slug_key on uniora.organizations (slug);
`;
