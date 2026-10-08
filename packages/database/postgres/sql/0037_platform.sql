-- @uniora/postgres migration 0037_platform
-- Generated from src/migrations/0037_platform.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Platform scope: who administers the WHOLE project (not one organization). It lives in its own schema, `uniora_platform`,
-- so the database itself keeps it apart from organization data: grant the application role that serves organizations no
-- access to this schema (see guides/sql/least-privilege-roles.sql) and a bug or injection in that code cannot reach it.
--
-- - `roles`: named sets of `platform.*` permissions. The system role `platform_admin` carries `platform.*`; only a system
--   role may. A system role cannot be updated or deleted (trigger).
-- - `members`: identities (provider + subject, exact; no link is followed) with a status.
-- - `member_roles`: which roles a member holds. A role that is still held cannot be deleted (restrict).
-- - The last active holder of `platform_admin` cannot be suspended, unassigned or removed: guarded by triggers that take
--   an advisory lock first, so two administrators demoting each other at the same instant cannot both succeed.
-- Platform changes are audited in `uniora.audit_logs` (global entries) in the same transaction.

create schema if not exists uniora_platform;

create table if not exists uniora_platform.roles (
  id text primary key check (length(id) between 1 and 200),
  key text not null unique check (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  permissions text[] not null check (cardinality(permissions) <= 100),
  is_system boolean not null default false,
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  updated_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  version integer not null default 1 check (version >= 1),
  check (is_system or not ('platform.*' = any (permissions)))
);

create table if not exists uniora_platform.members (
  id text primary key check (length(id) between 1 and 200),
  identity_provider text not null check (length(identity_provider) between 1 and 200),
  identity_subject text not null check (length(identity_subject) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  updated_at timestamptz(3) not null default date_trunc('milliseconds', now()),
  added_by_provider text not null,
  added_by_subject text not null,
  status_changed_at timestamptz(3),
  status_changed_by_provider text,
  status_changed_by_subject text,
  status_reason text check (status_reason is null or length(status_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  unique (identity_provider, identity_subject)
);
create index if not exists platform_members_status_idx on uniora_platform.members (status, id);

create table if not exists uniora_platform.member_roles (
  member_id text not null references uniora_platform.members (id) on delete cascade,
  role_id text not null references uniora_platform.roles (id) on delete restrict,
  primary key (member_id, role_id)
);
create index if not exists platform_member_roles_role_idx on uniora_platform.member_roles (role_id, member_id);

create or replace function uniora_platform.protect_system_role() returns trigger
language plpgsql as $$
begin
  if old.is_system then
    raise exception 'platform_role_system: a system role cannot be changed or deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

drop trigger if exists platform_roles_protect_system on uniora_platform.roles;
create trigger platform_roles_protect_system before update or delete on uniora_platform.roles
  for each row execute function uniora_platform.protect_system_role();

-- Whether some OTHER member than `except` is an active holder of the system role platform_admin.
create or replace function uniora_platform.other_active_admin(except_member text) returns boolean
language sql stable as $$
  select exists (
    select 1
    from uniora_platform.member_roles mr
    join uniora_platform.roles r on r.id = mr.role_id and r.is_system and r.key = 'platform_admin'
    join uniora_platform.members m on m.id = mr.member_id and m.status = 'active'
    where mr.member_id <> except_member
  )
$$;

create or replace function uniora_platform.guard_last_admin() returns trigger
language plpgsql as $$
declare
  holder text;
  holds boolean;
begin
  -- Serialise every change that could remove an administrator, then look again with a fresh snapshot.
  perform pg_advisory_xact_lock(hashtextextended('uniora:platform:admin', 0));
  if tg_table_name = 'members' then
    holder := old.id;
    holds := old.status = 'active' and exists (
      select 1 from uniora_platform.member_roles mr
      join uniora_platform.roles r on r.id = mr.role_id and r.is_system and r.key = 'platform_admin'
      where mr.member_id = old.id
    );
    if tg_op = 'UPDATE' and new.status = 'active' then holds := false; end if;
  else
    holder := old.member_id;
    holds := exists (select 1 from uniora_platform.roles r where r.id = old.role_id and r.is_system and r.key = 'platform_admin')
      and exists (select 1 from uniora_platform.members m where m.id = old.member_id and m.status = 'active');
  end if;
  if holds and not uniora_platform.other_active_admin(holder) then
    raise exception 'platform_last_admin: the platform must keep at least one active Platform Administrator' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

drop trigger if exists platform_members_guard_last_admin on uniora_platform.members;
create trigger platform_members_guard_last_admin before update of status or delete on uniora_platform.members
  for each row execute function uniora_platform.guard_last_admin();
drop trigger if exists platform_member_roles_guard_last_admin on uniora_platform.member_roles;
create trigger platform_member_roles_guard_last_admin before delete on uniora_platform.member_roles
  for each row execute function uniora_platform.guard_last_admin();
