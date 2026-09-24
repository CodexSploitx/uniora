import type { Role } from "./types.js";

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
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
  count(options?: { organizationId?: string; query?: string; heldBy?: string; notHeldBy?: string; isOwnerRole?: boolean }): Promise<number>;
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
   */
  grantPermission(roleId: string, permissionKey: string): Promise<void>;
  /** Idempotent (no-op if not granted). Rejects if the role is not found or is the protected Owner role. */
  revokePermission(roleId: string, permissionKey: string): Promise<void>;
  /** Rejects if the role is not found, is the protected Owner role, or the name collides with another role in the same organization. */
  rename(roleId: string, name: string): Promise<Role>;
  /**
   * Deletes the role and detaches it from every membership that had it
   * assigned. Rejects if the role is not found or is the protected Owner
   * role — the organization must always keep its Owner role.
   */
  delete(roleId: string): Promise<void>;
}
