/**
 * Indexes for Studio's organization-detail views, which must stay fast when a
 * single organization holds thousands of members, roles, permissions and
 * audit entries (see docs/studio.md).
 *
 * - `memberships (organization_id, id)`: `MembershipRepository.search` pages
 *   one organization's members in `id` order; the existing unique index is
 *   `(organization_id, provider, subject)`, which can't serve that order.
 * - `audit_logs (organization_id, created_at desc, id desc)`: keyset paging of
 *   one organization's log (`listByOrganization(..., { before })`). It fully
 *   covers the old `(organization_id, created_at desc)` index of migration
 *   0002, which is dropped so writes don't maintain two overlapping indexes.
 * - `membership_roles (role_id)`: "how many members hold this role" and the
 *   cascade on role delete look up by `role_id`; the primary key starts with
 *   `membership_id`.
 * - `role_permissions (permission_key)`: "granted to how many roles" (the
 *   `/permissions` page) and `PermissionRepository.unregister`'s in-use check
 *   look up by `permission_key`; the primary key starts with `role_id`.
 *
 * Index-only changes: no data is read or altered.
 */
export const MIGRATION_0013_DETAIL_INDEXES = `
create index if not exists memberships_organization_id_id_idx
  on uniora.memberships (organization_id, id);

create index if not exists audit_logs_organization_id_created_at_id_idx
  on uniora.audit_logs (organization_id, created_at desc, id desc);
drop index if exists uniora.audit_logs_organization_id_created_at_idx;

create index if not exists membership_roles_role_id_idx
  on uniora.membership_roles (role_id);

create index if not exists role_permissions_permission_key_idx
  on uniora.role_permissions (permission_key);
`;
