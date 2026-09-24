import { deriveSlug, matchesSlugPattern, MAX_SLUG_LENGTH } from "../shared/slug.js";
import { RoleError } from "./repository.js";

const MAX_NAME_LENGTH = 100;

// "owner" is reserved for the protected Owner role (`RoleRepository.createOwnerRole`)
// so a custom role can never take its key, even via a near-miss casing/spacing
// variant of the name ("OWNER", "Owner ") that exact-match name uniqueness
// wouldn't catch — see uniora-security-engineering §11 (Owner Protection) and
// STRIDE Spoofing: a custom role that reads like the real Owner in a role
// picker is a real confusion/impersonation risk, not just a cosmetic one.
const RESERVED_KEYS = new Set(["owner"]);

/**
 * Trims and collapses whitespace, rejects empty/oversized names. `name` is
 * a free-form display string (no character restrictions beyond length) —
 * unlike `key`, it's never used as a lookup identifier.
 */
export function sanitizeRoleName(name: string): string {
  if (typeof name !== "string") {
    throw new RoleError("Role name must be a string.");
  }
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new RoleError("Role name cannot be empty.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new RoleError(`Role name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/** Validates an explicit, caller-provided key. Throws (fail-closed) if malformed or reserved. */
export function assertValidRoleKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new RoleError("Role key cannot be empty.");
  }
  if (key.length > MAX_SLUG_LENGTH) {
    throw new RoleError(`Role key cannot exceed ${MAX_SLUG_LENGTH} characters.`);
  }
  if (!matchesSlugPattern(key)) {
    throw new RoleError(
      'Role key must be lowercase alphanumeric characters separated by single hyphens (e.g. "billing-manager").',
    );
  }
  if (RESERVED_KEYS.has(key)) {
    throw new RoleError(`Role key "${key}" is reserved for the protected Owner role.`);
  }
  return key;
}

/**
 * Resolves the key to persist for a new custom role: validates an explicit
 * key as-is, or derives and validates one from `name` when none is given
 * (same Clerk-style auto-derivation as `resolveOrganizationSlug`).
 * Uniqueness within the organization is enforced separately by each
 * `RoleRepository` adapter (a real unique index in `@uniora/postgres`).
 */
export function resolveRoleKey(name: string, explicitKey?: string): string {
  if (explicitKey !== undefined) return assertValidRoleKey(explicitKey);

  const derived = deriveSlug(name);
  if (derived.length === 0) {
    throw new RoleError("Could not derive a key from this role name — pass an explicit `key`.");
  }
  return assertValidRoleKey(derived);
}

/**
 * Rejects non-string/empty permission keys (type confusion, skill
 * §8.9/§8.10) when attaching a `permissionKey` to a role. Deliberately
 * **not** the real format standard for a permission key (`resource.action`
 * — see `PermissionRepository`/`permission/key.ts::assertValidPermissionKey`
 * for that): a role only needs to guard against malformed input here,
 * catalog membership/format is `PermissionRepository`'s responsibility
 * (enforced by a real FK + `check` constraint in `@uniora/postgres`).
 */
export function assertNonEmptyPermissionKey(permissionKey: string): string {
  if (typeof permissionKey !== "string" || permissionKey.trim().length === 0) {
    throw new RoleError("Permission key must be a non-empty string.");
  }
  return permissionKey;
}

/** Validates every entry and drops duplicates — a role never stores the same permission key twice. */
export function sanitizeRolePermissionKeys(permissionKeys: string[] | undefined): string[] {
  if (permissionKeys === undefined) return [];
  const unique = new Set<string>();
  for (const key of permissionKeys) {
    unique.add(assertNonEmptyPermissionKey(key));
  }
  return [...unique];
}
