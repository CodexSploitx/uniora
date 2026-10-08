import { PlatformError } from "./errors.js";

/**
 * The platform permission keys UNIORA's own platform service asks about. Hosts may define more under `platform.`
 * (`platform.billing.refund`) for their own admin panel and check them with `platformEngine.can`.
 */
export const PLATFORM_PERMISSIONS = {
  /** Read platform roles. */
  rolesRead: "platform.roles.read",
  /** Create, edit and delete platform roles (within the permissions you hold yourself). */
  rolesManage: "platform.roles.manage",
  /** Read platform members. */
  membersRead: "platform.members.read",
  /** Add, suspend, reactivate and remove platform members and change their roles (never above your own permissions). */
  membersManage: "platform.members.manage",
  /** List and read organizations. */
  organizationsRead: "platform.organizations.read",
  /** Suspend, archive and reactivate organizations. */
  organizationsManage: "platform.organizations.manage",
  /** Open a temporary, audited support grant for yourself in an organization. */
  supportGrant: "platform.support.grant",
  /** Read the platform audit trail. */
  auditRead: "platform.audit.read",
} as const;

/** Everything. Only the system role `platform_admin` may carry it. */
export const PLATFORM_ALL = "platform.*";

export const MAX_PLATFORM_PERMISSION_LENGTH = 150;
export const MAX_PLATFORM_ROLE_PERMISSIONS = 100;

const CONCRETE = /^platform(\.[a-z0-9_]+)+$/;
const WILDCARD = /^platform(\.[a-z0-9_]+)*\.\*$/;

export function isPlatformWildcard(key: string): boolean {
  return key.endsWith(".*");
}

/** A well-formed platform key: `platform.<segments>` or a prefix wildcard ending in `.*`. */
export function isValidPlatformPermission(key: unknown, options: { allowWildcard?: boolean } = {}): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_PLATFORM_PERMISSION_LENGTH) return false;
  if (CONCRETE.test(key)) return true;
  return options.allowWildcard !== false && WILDCARD.test(key);
}

export function assertValidPlatformPermission(key: unknown, options: { allowWildcard?: boolean } = {}): asserts key is string {
  if (!isValidPlatformPermission(key, options)) {
    throw new PlatformError(
      `"${String(key).slice(0, 80)}" is not a platform permission: it must be lowercase, dot-separated and start with "platform." (a trailing ".*" covers a prefix).`,
      "platform_permission_invalid",
    );
  }
}

/** Whether the held key `held` covers `wanted`: equal, or a wildcard whose prefix `wanted` starts with. */
export function platformKeyCovers(held: string, wanted: string): boolean {
  if (held === wanted) return true;
  if (!isPlatformWildcard(held)) return false;
  return wanted.startsWith(held.slice(0, -1));
}

/** Whether any of `held` covers `wanted` (a concrete key or a wildcard). */
export function platformPermissionsCover(held: Iterable<string>, wanted: string): boolean {
  for (const key of held) if (platformKeyCovers(key, wanted)) return true;
  return false;
}

/** Whether `held` covers every key in `wanted`. */
export function platformPermissionsCoverAll(held: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((key) => platformPermissionsCover(held, key));
}
