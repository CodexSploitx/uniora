import { PermissionError } from "./repository.js";

const MAX_NAME_LENGTH = 100;
const MAX_KEY_LENGTH = 150;

// A lowercase, dot-namespaced "resource.action" identifier — at least two
// segments, each lowercase alphanumeric/underscore (e.g. "vehicles.delete",
// "audit_logs.read"). Mirrors the shape already used throughout
// docs/PROYECT.md and uniora-security-engineering §9 ("Permission
// Naming"): deterministic, normalized, validated, impossible to interpret
// ambiguously.
const PERMISSION_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/**
 * Trims and collapses whitespace, rejects empty/oversized names. `name` is
 * an optional, free-form display label — unlike `key`, it's never used as
 * a lookup identifier.
 */
export function sanitizePermissionName(name: string): string {
  if (typeof name !== "string") {
    throw new PermissionError("Permission name must be a string.");
  }
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new PermissionError("Permission name cannot be empty.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new PermissionError(`Permission name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Validates a permission key. Unlike Organization's slug, Role's key or
 * Feature's key, there is no `resolvePermissionKey` — a permission key is
 * always explicit, **never** derived from a name. uniora-security-
 * engineering §9 ("Permission Naming") warns against silently normalizing
 * a security-sensitive identifier in ways that could cause collisions: a
 * permission key is what a developer writes directly into
 * `can({ permission: "..." })`, so this only ever validates and rejects
 * (fail-closed) — it never transforms the input the way `deriveSlug`/
 * `deriveFeatureKey` do for the other three entities.
 */
export function assertValidPermissionKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new PermissionError("Permission key cannot be empty.");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new PermissionError(`Permission key cannot exceed ${MAX_KEY_LENGTH} characters.`);
  }
  if (!PERMISSION_KEY_PATTERN.test(key)) {
    throw new PermissionError(
      'Permission key must be a lowercase, dot-namespaced "resource.action" identifier (e.g. "vehicles.delete") — each segment lowercase alphanumeric/underscore, at least two segments.',
    );
  }
  return key;
}
