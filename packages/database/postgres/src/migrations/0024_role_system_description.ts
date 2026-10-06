/**
 * System roles and descriptions. `is_system` marks a role the host's code defines (see `applyRoleTemplates`): it cannot
 * be renamed or deleted, its permissions can still change. `description` is free text for admins (500 characters).
 * Every existing role is a regular role without a description.
 */
export const MIGRATION_0024_ROLE_SYSTEM_DESCRIPTION = `
alter table uniora.roles add column if not exists is_system boolean not null default false;
alter table uniora.roles add column if not exists description text check (description is null or length(description) <= 500);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'roles_system_not_owner' and conrelid = 'uniora.roles'::regclass) then
    alter table uniora.roles add constraint roles_system_not_owner check (not (is_system and is_owner_role));
  end if;
end
$$;
`;
