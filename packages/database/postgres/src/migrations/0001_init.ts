/**
 * Initial UNIORA schema (docs/PROYECT.md §18): a dedicated `uniora`
 * namespace so these tables never collide with the client application's
 * own `organizations`, `users`, `roles`, `permissions`, etc.
 */
export const MIGRATION_0001_INIT = `
create schema if not exists uniora;

create table if not exists uniora.organizations (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists uniora.permissions (
  key text primary key,
  description text
);

create table if not exists uniora.roles (
  id text primary key,
  organization_id text not null references uniora.organizations(id) on delete cascade,
  name text not null
);

create table if not exists uniora.role_permissions (
  role_id text not null references uniora.roles(id) on delete cascade,
  permission_key text not null references uniora.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists uniora.memberships (
  id text primary key,
  organization_id text not null references uniora.organizations(id) on delete cascade,
  provider text not null,
  subject text not null,
  unique (organization_id, provider, subject)
);

create table if not exists uniora.membership_roles (
  membership_id text not null references uniora.memberships(id) on delete cascade,
  role_id text not null references uniora.roles(id) on delete cascade,
  primary key (membership_id, role_id)
);

create table if not exists uniora.features (
  organization_id text not null references uniora.organizations(id) on delete cascade,
  key text not null,
  enabled boolean not null default false,
  primary key (organization_id, key)
);
`;
