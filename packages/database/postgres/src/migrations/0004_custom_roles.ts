/**
 * Custom Roles (roadmap V1.x) + the protected Owner role
 * (uniora-security-engineering §11 Owner Protection).
 *
 * - `is_owner_role`: marks the organization's single protected Owner
 *   role. Only `RoleRepository.createOwnerRole` ever inserts a row with
 *   this true — `create()` never accepts it as input.
 * - A partial unique index enforces "at most one Owner role per
 *   organization" as a real database constraint (skill §20), not just
 *   application logic.
 * - A unique index on (organization_id, name) enforces that custom role
 *   names never collide within the same organization.
 */
export const MIGRATION_0004_CUSTOM_ROLES = `
alter table uniora.roles add column if not exists is_owner_role boolean not null default false;

create unique index if not exists roles_one_owner_role_per_org
  on uniora.roles (organization_id)
  where is_owner_role;

create unique index if not exists roles_org_name_key
  on uniora.roles (organization_id, name);
`;
