/**
 * Platform scope (same model as `@uniora/postgres`'s `0037_platform`): who administers the WHOLE project, kept in `uniora_platform_*`
 * tables that no organization table references. SQLite has no schemas or per-table grants: keep the platform storage out of code
 * that serves organizations, or open this file with a separate connection for it.
 *
 * - `uniora_platform_roles`: named sets of `platform.*` permissions (JSON text). Only a system role may carry `platform.*`
 *   (check); a system role cannot be updated or deleted (triggers).
 * - `uniora_platform_members`: exact identities with a status. `uniora_platform_member_roles`: the roles they hold; a role that
 *   is still held cannot be deleted (restrict).
 * - The last active holder of `platform_admin` cannot be suspended, unassigned or removed (triggers raise `platform_last_admin`).
 */
export const MIGRATION_0022_PLATFORM = `
create table if not exists uniora_platform_roles (
  id text primary key check (length(id) between 1 and 200),
  key text not null unique check (length(key) between 2 and 63 and key not glob '*[^a-z0-9_-]*' and key glob '[a-z]*'),
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  permissions text not null default '[]' check (json_valid(permissions) and json_type(permissions) = 'array' and json_array_length(permissions) <= 100),
  is_system integer not null default 0 check (is_system in (0, 1)),
  created_at text not null,
  updated_at text not null,
  version integer not null default 1 check (version >= 1),
  check (is_system = 1 or instr(permissions, '"platform.*"') = 0)
);

create table if not exists uniora_platform_members (
  id text primary key check (length(id) between 1 and 200),
  identity_provider text not null check (length(identity_provider) between 1 and 200),
  identity_subject text not null check (length(identity_subject) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at text not null,
  updated_at text not null,
  added_by_provider text not null,
  added_by_subject text not null,
  status_changed_at text,
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text check (status_reason is null or length(status_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  unique (identity_provider, identity_subject)
);
create index if not exists uniora_platform_members_status_idx on uniora_platform_members (status, id);

create table if not exists uniora_platform_member_roles (
  member_id text not null references uniora_platform_members (id) on delete cascade,
  role_id text not null references uniora_platform_roles (id) on delete restrict,
  primary key (member_id, role_id)
);
create index if not exists uniora_platform_member_roles_role_idx on uniora_platform_member_roles (role_id, member_id);

create trigger if not exists uniora_platform_roles_system_update
before update on uniora_platform_roles
when old.is_system = 1
begin
  select raise(abort, 'platform_role_system: a system role cannot be changed or deleted');
end;

create trigger if not exists uniora_platform_roles_system_delete
before delete on uniora_platform_roles
when old.is_system = 1
begin
  select raise(abort, 'platform_role_system: a system role cannot be changed or deleted');
end;

create trigger if not exists uniora_platform_members_last_admin_suspend
before update of status on uniora_platform_members
when old.status = 'active' and new.status <> 'active'
  and exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    where mr.member_id = old.id)
  and not exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    join uniora_platform_members m on m.id = mr.member_id and m.status = 'active'
    where mr.member_id <> old.id)
begin
  select raise(abort, 'platform_last_admin: the platform must keep at least one active Platform Administrator');
end;

create trigger if not exists uniora_platform_members_last_admin_delete
before delete on uniora_platform_members
when old.status = 'active'
  and exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    where mr.member_id = old.id)
  and not exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    join uniora_platform_members m on m.id = mr.member_id and m.status = 'active'
    where mr.member_id <> old.id)
begin
  select raise(abort, 'platform_last_admin: the platform must keep at least one active Platform Administrator');
end;

create trigger if not exists uniora_platform_member_roles_last_admin
before delete on uniora_platform_member_roles
when exists (select 1 from uniora_platform_roles r where r.id = old.role_id and r.is_system = 1 and r.key = 'platform_admin')
  and exists (select 1 from uniora_platform_members m where m.id = old.member_id and m.status = 'active')
  and not exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    join uniora_platform_members m on m.id = mr.member_id and m.status = 'active'
    where mr.member_id <> old.member_id)
begin
  select raise(abort, 'platform_last_admin: the platform must keep at least one active Platform Administrator');
end;
`;
