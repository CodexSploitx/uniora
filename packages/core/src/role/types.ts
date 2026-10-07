/**
 * A reusable set of permissions, scoped to an organization so that
 * custom roles never leak across tenants (docs/PROYECT.md §27, §34).
 */
export interface Role {
  readonly id: string;
  readonly organizationId: string;
  /**
   * True only for the organization's protected Owner role, created via
   * `RoleRepository.createOwnerRole` (never via `create`). The
   * Authorization Engine grants it every permission unconditionally,
   * regardless of `permissionKeys` — see uniora-security-engineering §11
   * (Owner Protection).
   */
  readonly isOwnerRole: boolean;
  /**
   * Stable, URL-safe identifier, unique within the organization —
   * "owner" for the protected Owner role, derived from `name` or
   * caller-supplied for custom roles (see `resolveRoleKey`). Immutable
   * after creation: `rename()` only ever changes `name`, never `key`.
   */
  readonly key: string;
  name: string;
  /** Free text for admins (at most 500 characters), e.g. what the role is for. */
  description?: string;
  /**
   * A role the host's code defines (created from a template, see `applyRoleTemplates`) rather than one a tenant made:
   * it cannot be renamed or deleted, but its permissions can still be changed. The protected Owner role is separate
   * (`isOwnerRole`) and is not "system".
   */
  readonly isSystem: boolean;
  permissionKeys: string[];
}
