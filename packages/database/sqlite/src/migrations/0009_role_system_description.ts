/**
 * System roles and descriptions — same model as `@uniora/postgres`'s `0024_role_system_description`. `is_system` marks
 * a role the host's code defines (see `applyRoleTemplates`): it cannot be renamed or deleted, its permissions can still
 * change. Every existing role is a regular role without a description.
 */
export const MIGRATION_0009_ROLE_SYSTEM_DESCRIPTION = `
alter table uniora_roles add column is_system integer not null default 0 check (is_system in (0, 1) and not (is_system = 1 and is_owner_role = 1));
alter table uniora_roles add column description text check (description is null or length(description) <= 500);
`;
