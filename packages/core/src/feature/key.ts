import { FeatureError } from "./repository.js";

const MAX_NAME_LENGTH = 100;
const MAX_KEY_LENGTH = 63;

// Lowercase alphanumeric segments separated by single underscores — no
// leading, trailing, or duplicate underscores. Deliberately different
// from Organization's/Role's hyphenated slug: a feature key is a
// programmatic flag name (env-var/flag-style), never a URL segment, and
// matches the convention already used throughout docs/PROYECT.md's own
// examples ("advanced_reports", "ai_assistant", "bulk_import").
const FEATURE_KEY_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/**
 * Trims and collapses whitespace, rejects empty/oversized names. `name` is
 * a free-form display string (no character restrictions beyond length) —
 * unlike `key`, it's never used as a lookup identifier.
 */
export function sanitizeFeatureName(name: string): string {
  if (typeof name !== "string") {
    throw new FeatureError("Feature name must be a string.");
  }
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new FeatureError("Feature name cannot be empty.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new FeatureError(`Feature name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

function deriveFeatureKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/g, "");
}

/** Validates an explicit, caller-provided key. Throws (fail-closed) if malformed. */
export function assertValidFeatureKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new FeatureError("Feature key cannot be empty.");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new FeatureError(`Feature key cannot exceed ${MAX_KEY_LENGTH} characters.`);
  }
  if (!FEATURE_KEY_PATTERN.test(key)) {
    throw new FeatureError(
      'Feature key must be lowercase alphanumeric characters separated by single underscores (e.g. "advanced_reports").',
    );
  }
  return key;
}

/**
 * Resolves the key to persist for a feature definition: validates an
 * explicit key as-is, or derives and validates one from `name` when none
 * is given (same Clerk-style auto-derivation as `resolveOrganizationSlug`/
 * `resolveRoleKey`, underscore-separated instead of hyphenated). No
 * uniqueness check here — unlike Organization/Role, `register()` is an
 * idempotent upsert (same contract as `PermissionRepository.register`),
 * so a repeated key is never rejected.
 */
export function resolveFeatureKey(name: string, explicitKey?: string): string {
  if (explicitKey !== undefined) return assertValidFeatureKey(explicitKey);

  const derived = deriveFeatureKey(name);
  if (derived.length === 0) {
    throw new FeatureError("Could not derive a key from this feature name — pass an explicit `key`.");
  }
  return assertValidFeatureKey(derived);
}
