/**
 * UNIORA's schema for SQLite, at the shape `@uniora/postgres`'s migrations
 * 0001-0015 converge on — a new adapter starts at the current schema instead
 * of replaying that history. Future changes are new numbered migrations.
 *
 * SQLite has no schemas, so every table carries a `uniora_` prefix: same
 * "never collide with the host application's own `organizations`, `roles`,
 * ..." guarantee as Postgres' dedicated `uniora` namespace.
 *
 * Representation choices (all dictated by what SQLite lacks):
 * - Timestamps are ISO-8601 text with millisecond precision
 *   (`2026-10-06T18:43:00.123Z`, exactly what `Date#toISOString` yields). The
 *   fixed width makes them sort chronologically as plain strings, and a keyset
 *   cursor rebuilt from a JS `Date` equals the stored value bit for bit — the
 *   truncation bug Postgres needed its migration 0011 for cannot occur.
 * - Booleans are `integer` 0/1 with a `check`; `metadata` is JSON text.
 * - Permission key format is enforced by a real `check` (SQLite has no
 *   regex): only `[a-z0-9_.]`, at least one dot, never leading, trailing or
 *   doubled — the same language as Postgres' `^[a-z0-9_]+(\.[a-z0-9_]+)+$`.
 * - "At most one Owner role per organization" is a partial unique index and
 *   "every feature is registered" a foreign key, exactly like Postgres: real
 *   constraints, not application logic. (They need `pragma foreign_keys = on`,
 *   which the adapter turns on and verifies for every connection it uses.)
 */
export const MIGRATION_0001_INIT = `
create table if not exists uniora_organizations (
  id text primary key,
  name text not null,
  slug text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index if not exists uniora_organizations_slug_key on uniora_organizations (slug);
create index if not exists uniora_organizations_created_at_id_idx on uniora_organizations (created_at asc, id asc);

create table if not exists uniora_permissions (
  key text primary key,
  name text,
  description text,
  constraint uniora_permissions_key_format check (
    key not glob '*[^a-z0-9_.]*'
    and key glob '*.*'
    and key not glob '.*'
    and key not glob '*.'
    and key not glob '*..*'
  )
);

create table if not exists uniora_roles (
  id text primary key,
  organization_id text not null references uniora_organizations (id) on delete cascade,
  name text not null,
  key text not null,
  is_owner_role integer not null default 0 check (is_owner_role in (0, 1))
);
create unique index if not exists uniora_roles_one_owner_role_per_org on uniora_roles (organization_id) where is_owner_role = 1;
create unique index if not exists uniora_roles_org_name_key on uniora_roles (organization_id, name);
create unique index if not exists uniora_roles_org_key_key on uniora_roles (organization_id, key);

create table if not exists uniora_role_permissions (
  role_id text not null references uniora_roles (id) on delete cascade,
  permission_key text not null references uniora_permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);
create index if not exists uniora_role_permissions_permission_key_idx on uniora_role_permissions (permission_key);

create table if not exists uniora_memberships (
  id text primary key,
  organization_id text not null references uniora_organizations (id) on delete cascade,
  provider text not null,
  subject text not null,
  unique (organization_id, provider, subject)
);
create index if not exists uniora_memberships_organization_id_id_idx on uniora_memberships (organization_id, id);

create table if not exists uniora_membership_roles (
  membership_id text not null references uniora_memberships (id) on delete cascade,
  role_id text not null references uniora_roles (id) on delete cascade,
  primary key (membership_id, role_id)
);
create index if not exists uniora_membership_roles_role_id_idx on uniora_membership_roles (role_id);

create table if not exists uniora_feature_definitions (
  key text primary key,
  name text not null,
  description text
);

create table if not exists uniora_features (
  organization_id text not null references uniora_organizations (id) on delete cascade,
  key text not null references uniora_feature_definitions (key) on delete cascade,
  enabled integer not null default 0 check (enabled in (0, 1)),
  primary key (organization_id, key)
);
create index if not exists uniora_features_key_enabled_idx on uniora_features (key, organization_id) where enabled = 1;

-- Deliberately NOT \`on delete cascade\` on organization_id (and nullable, for
-- global entries such as identity links): an audit trail must outlive what it
-- records, same reasoning as Postgres' migrations 0002/0014.
create table if not exists uniora_audit_logs (
  id text primary key,
  organization_id text references uniora_organizations (id),
  actor_provider text not null,
  actor_subject text not null,
  action text not null,
  target_type text,
  target_id text,
  metadata text check (metadata is null or json_valid(metadata)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create index if not exists uniora_audit_logs_created_at_id_idx on uniora_audit_logs (created_at desc, id desc);
create index if not exists uniora_audit_logs_organization_id_created_at_id_idx
  on uniora_audit_logs (organization_id, created_at desc, id desc);

-- Global on purpose (a provider migration applies in every organization the
-- person belongs to). The primary key on \`from\` is the database-level backstop
-- against two concurrent link() calls for the same identity.
create table if not exists uniora_identity_links (
  from_provider text not null,
  from_subject text not null,
  to_provider text not null,
  to_subject text not null,
  linked_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (from_provider, from_subject)
);
create index if not exists uniora_identity_links_to_idx on uniora_identity_links (to_provider, to_subject);
`;
