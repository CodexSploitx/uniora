/**
 * Closes the ways a raw SQL client could still skip the platform guards of `0022_platform` (found by the red-team review):
 *
 * - `UPDATE uniora_platform_member_roles SET role_id / member_id` moved an administrator's link without a DELETE, so the
 *   last-admin trigger never ran. A BEFORE UPDATE trigger now treats it as removing the old link.
 * - `INSERT OR REPLACE` deletes the conflicting row WITHOUT firing delete triggers (SQLite only fires them with
 *   `recursive_triggers`). BEFORE INSERT triggers now abort when the row would conflict, whatever the conflict clause says.
 * - A row's `id` can no longer change, and `is_system` can no longer be switched on (or set on any key but `platform_admin`).
 */
export const MIGRATION_0023_PLATFORM_HARDENING = `
create trigger if not exists uniora_platform_member_roles_last_admin_move
before update of member_id, role_id on uniora_platform_member_roles
when (old.member_id <> new.member_id or old.role_id <> new.role_id)
  and exists (select 1 from uniora_platform_roles r where r.id = old.role_id and r.is_system = 1 and r.key = 'platform_admin')
  and exists (select 1 from uniora_platform_members m where m.id = old.member_id and m.status = 'active')
  and not exists (
    select 1 from uniora_platform_member_roles mr
    join uniora_platform_roles r on r.id = mr.role_id and r.is_system = 1 and r.key = 'platform_admin'
    join uniora_platform_members m on m.id = mr.member_id and m.status = 'active'
    where mr.member_id <> old.member_id)
begin
  select raise(abort, 'platform_last_admin: the platform must keep at least one active Platform Administrator');
end;

create trigger if not exists uniora_platform_members_no_replace
before insert on uniora_platform_members
when exists (
  select 1 from uniora_platform_members
  where id = new.id or (identity_provider = new.identity_provider and identity_subject = new.identity_subject))
begin
  select raise(abort, 'platform_duplicate: that platform member already exists');
end;

create trigger if not exists uniora_platform_roles_no_replace
before insert on uniora_platform_roles
when exists (select 1 from uniora_platform_roles where id = new.id or key = new.key)
begin
  select raise(abort, 'platform_duplicate: that platform role already exists');
end;

create trigger if not exists uniora_platform_members_id_immutable
before update of id on uniora_platform_members
when old.id <> new.id
begin
  select raise(abort, 'platform_immutable: a platform member id cannot change');
end;

create trigger if not exists uniora_platform_roles_id_immutable
before update of id on uniora_platform_roles
when old.id <> new.id
begin
  select raise(abort, 'platform_immutable: a platform role id cannot change');
end;

create trigger if not exists uniora_platform_roles_system_flag_update
before update of is_system, key on uniora_platform_roles
when (new.is_system = 1 and (old.is_system = 0 or new.key <> 'platform_admin'))
begin
  select raise(abort, 'platform_role_system: only the platform_admin role can be a system role, and it cannot be switched on');
end;

create trigger if not exists uniora_platform_roles_system_flag_insert
before insert on uniora_platform_roles
when new.is_system = 1 and new.key <> 'platform_admin'
begin
  select raise(abort, 'platform_role_system: only the platform_admin role can be a system role');
end;
`;
