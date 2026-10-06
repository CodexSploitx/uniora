import { UnioraError, inferErrorCode } from "../shared/errors.js";
import type { RoleErrorCode } from "../shared/errors.js";
import type { Role } from "./types.js";

export class RoleError extends UnioraError {
  constructor(message: string, code?: RoleErrorCode) {
    super(message, code ?? inferErrorCode("role", message));
    this.name = "RoleError";
  }
}

export interface CreateRoleInput {
  id: string;
  organizationId: string;
  name: string;
  /**
   * Stable, URL-safe handle, unique within the organization. Optional —
   * derived from `name` when omitted (see `resolveRoleKey`). Rejected
   * (`RoleError`) if malformed, reserved ("owner"), or if it collides
   * with an existing role's key in the same organization.
   */
  key?: string;
  permissionKeys?: string[];
  /** At most 500 characters. */
  description?: string;
  /** Marks a role the host's code defines (see `Role.isSystem`). Normally set through `applyRoleTemplates`. */
  isSystem?: boolean;
}

export interface UpdateRoleInput {
  /** New display name; refused (`role_system_protected`) on a system role. */
  name?: string;
  /** New description, or `null` to clear it. */
  description?: string | null;
}

export interface CloneRoleInput {
  id: string;
  name: string;
  /** Optional handle, derived from `name` when omitted (see `resolveRoleKey`). */
  key?: string;
  /** Clone into another organization (e.g. from a template organization). Defaults to the source's. */
  organizationId?: string;
  /** Defaults to the source's description. */
  description?: string;
}

export interface SetRolePermissionsResult {
  /** Keys that were added. */
  granted: string[];
  /** Keys that were removed. */
  revoked: string[];
}

/** What `delete` does with the members that still hold the role. */
export type DeleteRoleMembers = "detach" | "reject" | { reassignTo: string };

export interface DeleteRoleOptions {
  /**
   * `"detach"` (default, as before): the role is removed from its members, who keep their other roles.
   * `"reject"`: refuse (`role_in_use`) while any membership holds it.
   * `{ reassignTo }`: every holder gets that role (same organization, not the Owner role) before this one is deleted.
   */
  members?: DeleteRoleMembers;
}

export interface CreateOwnerRoleInput {
  id: string;
  organizationId: string;
}

/** A role without its permission list — cheap to load in bulk, however many permissions it holds. */
export interface RoleSummary {
  id: string;
  organizationId: string;
  name: string;
  key: string;
  isOwnerRole: boolean;
  isSystem: boolean;
}

export interface SearchRolesOptions {
  organizationId: string;
  limit?: number;
  /** Keyset cursor — the `key` of the last role of the previous page (keys are unique per organization). */
  after?: string;
  /** Case-insensitive substring match against `name` or `key`. */
  query?: string;
  /** Only roles currently held by this membership. */
  heldBy?: string;
  /** Only roles NOT held by this membership (e.g. a role picker for that member). */
  notHeldBy?: string;
  /** `true` = only the protected Owner role, `false` = everything but it. */
  isOwnerRole?: boolean;
  /** `true` = only system roles, `false` = only the ones tenants made. */
  isSystem?: boolean;
}

export interface RoleRepository {
  /**
   * Creates a regular custom role — never the protected Owner role (there
   * is no way to pass `isOwnerRole` here by design, see `createOwnerRole`).
   * `name` is sanitized (trimmed, collapsed whitespace, length-bounded —
   * see `sanitizeRoleName`) and `key` is resolved/validated (explicit or
   * derived from `name` — see `resolveRoleKey`). Rejects (fail-closed) if
   * another role in the same organization already has this exact name or
   * this key, or if the key is malformed/reserved ("owner").
   * `permissionKeys` must already be registered via `PermissionRepository.register` — adapters may enforce this with a foreign key.
   *
   * **Performs no authorization of its own** — it does not check that the
   * caller may create roles (or grant the requested `permissionKeys`) in
   * `organizationId`. The host application must authorize that decision
   * itself before calling this primitive (uniora-security-engineering
   * §71-72 "Unsafe APIs"; docs/security-pentest-2026-09-24.md Hallazgo 3).
   */
  create(input: CreateRoleInput): Promise<Role>;
  /**
   * Creates the organization's protected Owner role: `isOwnerRole: true`,
   * name "Owner", no `permissionKeys` (the Authorization Engine grants it
   * every permission unconditionally via the flag, not via the list).
   * This is the only method that can ever produce `isOwnerRole: true` —
   * intentionally absent from `CreateRoleInput`/`create()`. Rejects if the
   * organization already has an Owner role (exactly one per organization).
   * Callers should normally go through `createOrganizationWithOwner`
   * rather than calling this directly.
   */
  createOwnerRole(input: CreateOwnerRoleInput): Promise<Role>;
  findByIds(ids: string[]): Promise<Role[]>;
  listByOrganization(organizationId: string): Promise<Role[]>;
  /** Lightweight lookup by ids — unknown ids are absent; no permission lists are loaded. */
  findSummariesByIds(ids: string[]): Promise<RoleSummary[]>;
  /** Paginated, optionally filtered roles of one organization (keyset on `key`), without permission lists. */
  search(options: SearchRolesOptions): Promise<RoleSummary[]>;
  /** Count of roles (optionally within one organization / matching `query`) — never loads rows. */
  count(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean; isSystem?: boolean }): Promise<number>;
  /** How many permissions each of the given roles holds, in one call (`0` when none). The Owner role's flag-based full access is not a list and counts as 0. */
  countPermissions(roleIds: string[]): Promise<Record<string, number>>;
  /**
   * For each of `keys`: which of the roles a membership holds grant it (a
   * bounded preview of `perKey` roles + how many in total). Explains WHY a
   * member has a permission, in one call for a whole page of permissions.
   * Keys granted through no held role are present with `{ total: 0, roles: [] }`.
   */
  grantingRoles(membershipId: string, keys: string[], perKey: number): Promise<Record<string, { total: number; roles: RoleSummary[] }>>;
  /** Which of `keys` are granted to `roleId` — one call for a whole page of permissions. */
  grantedPermissionKeys(roleId: string, keys: string[]): Promise<string[]>;
  /**
   * Roles per organization for a batch of organization ids, in one call.
   * Every requested id is present (`0` when it has none).
   */
  countByOrganization(organizationIds: string[]): Promise<Record<string, number>>;
  /**
   * `permissionKey` must already be registered via `PermissionRepository.register`.
   * Rejects if the role is not found or is the protected Owner role.
   *
   * **Performs no authorization of its own** — it does not check that the
   * caller may grant `permissionKey` to this role. The host application must
   * authorize that decision itself (typically via `engine.can()`) before
   * calling this primitive (uniora-security-engineering §71-72 "Unsafe
   * APIs"; docs/security-pentest-2026-09-24.md Hallazgo 3).
   */
  grantPermission(roleId: string, permissionKey: string): Promise<void>;
  /**
   * Idempotent (no-op if not granted). Rejects if the role is not found or
   * is the protected Owner role.
   *
   * **Performs no authorization of its own** — same trust boundary as
   * `grantPermission` above.
   */
  revokePermission(roleId: string, permissionKey: string): Promise<void>;
  /** Rejects if the role is not found, is the protected Owner role or a system role, or the name collides with another role in the same organization. */
  rename(roleId: string, name: string): Promise<Role>;
  /**
   * Changes the name and/or the description in one step (`role_update_empty` if neither is given). The Owner role
   * and system roles keep their name (`owner_role_protected`, `role_system_protected`); a system role's description
   * can still be edited.
   */
  update(roleId: string, input: UpdateRoleInput): Promise<Role>;
  /**
   * Makes the role hold EXACTLY `permissionKeys`: adds the missing ones and removes the rest in ONE atomic step, so
   * a role is never left half-way (no revoke-all-then-grant window). Every key must be registered
   * (`role_permission_invalid`). Rejects the protected Owner role. Returns what changed.
   *
   * **Performs no authorization of its own** — same trust boundary as `grantPermission`.
   */
  setPermissions(roleId: string, permissionKeys: string[]): Promise<SetRolePermissionsResult>;
  /**
   * A new custom role with the same permissions (and, unless overridden, description) as `roleId`, in the same
   * organization or in `organizationId`. The clone is never a system role. Rejects the Owner role
   * (`owner_role_protected`: its power is a flag, not a list) and an unknown source.
   */
  clone(roleId: string, input: CloneRoleInput): Promise<Role>;
  /**
   * Deletes the role. `options.members` decides what happens to the memberships that hold it (default: detached).
   * Rejects if the role is not found, is the protected Owner role, or a system role (`role_system_protected`).
   *
   * **Performs no authorization of its own** — same trust boundary as `create`/`grantPermission` above.
   */
  delete(roleId: string, options?: DeleteRoleOptions): Promise<void>;
}
