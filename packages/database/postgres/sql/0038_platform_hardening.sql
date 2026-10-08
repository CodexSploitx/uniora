-- @uniora/postgres migration 0038_platform_hardening
-- Generated from src/migrations/0038_platform_hardening.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Closes the ways a raw SQL client could still skip the platform guards of `0037_platform` (found by the red-team review):
--
-- - `UPDATE uniora_platform.member_roles SET role_id / member_id` moved an administrator's link without a DELETE, so the
--   last-admin trigger never ran. It now runs on those updates too.
-- - Under REPEATABLE READ two administrators could suspend each other (write skew): the lock serialises them but each keeps
--   its old snapshot. The guard now refuses to run in that isolation level (READ COMMITTED and SERIALIZABLE are safe; the
--   platform storage always opens READ COMMITTED transactions).
-- - A role can be a system role, or carry \`platform.*\`, only if its key is \`platform_admin\`; \`is_system\` can no longer be
--   switched on after creation.
--
-- What a database superuser or table owner can do (TRUNCATE, \`session_replication_role = replica\`, \`DISABLE TRIGGER\`, editing the
-- functions) is outside what triggers can defend: give the application role no such privilege (guides/sql/least-privilege-roles.sql).

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_roles_system_key') then
    alter table uniora_platform.roles add constraint platform_roles_system_key check (not is_system or key = 'platform_admin');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_roles_wildcard_key') then
    alter table uniora_platform.roles add constraint platform_roles_wildcard_key check (not ('platform.*' = any (permissions)) or key = 'platform_admin');
  end if;
end
$$;

create or replace function uniora_platform.protect_system_flag() returns trigger
language plpgsql as $$
begin
  raise exception 'platform_role_system: the system flag of a role cannot be switched on' using errcode = 'P0001';
end
$$;

drop trigger if exists platform_roles_protect_system_flag on uniora_platform.roles;
create trigger platform_roles_protect_system_flag before update of is_system on uniora_platform.roles
  for each row when (old.is_system is distinct from new.is_system) execute function uniora_platform.protect_system_flag();

create or replace function uniora_platform.guard_last_admin() returns trigger
language plpgsql as $$
declare
  holder text;
  holds boolean;
begin
  -- Serialise every change that could remove an administrator, then look again with a fresh snapshot.
  perform pg_advisory_xact_lock(hashtextextended('uniora:platform:admin', 0));
  if current_setting('transaction_isolation') = 'repeatable read' then
    -- The lock does not refresh a REPEATABLE READ snapshot, so two concurrent changes could each miss the other's effect.
    raise exception 'platform_isolation: platform administrators must be changed under READ COMMITTED or SERIALIZABLE, not REPEATABLE READ' using errcode = 'P0001';
  end if;
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

drop trigger if exists platform_member_roles_guard_last_admin_move on uniora_platform.member_roles;
create trigger platform_member_roles_guard_last_admin_move before update of member_id, role_id on uniora_platform.member_roles
  for each row when (old.member_id is distinct from new.member_id or old.role_id is distinct from new.role_id)
  execute function uniora_platform.guard_last_admin();
