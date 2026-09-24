import { deriveSlug, matchesSlugPattern, MAX_SLUG_LENGTH } from "../shared/slug.js";

export class OrganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationError";
  }
}

const MAX_NAME_LENGTH = 255;

/**
 * Trims and collapses whitespace, rejects empty/oversized names. `name` is
 * a free-form display string (no character restrictions beyond length) —
 * unlike `slug`, it's never used as a URL segment.
 */
export function sanitizeOrganizationName(name: string): string {
  if (typeof name !== "string") {
    throw new OrganizationError("Organization name must be a string.");
  }
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new OrganizationError("Organization name cannot be empty.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new OrganizationError(`Organization name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Derives a URL-safe slug from a display name (e.g. "Acme del Oeste" ->
 * "acme-del-oeste", "Organización" -> "organizacion").
 */
export function slugify(name: string): string {
  return deriveSlug(name);
}

/** Validates an explicit, caller-provided slug. Throws (fail-closed) if malformed. */
export function assertValidSlug(slug: string): string {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new OrganizationError("Organization slug cannot be empty.");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new OrganizationError(`Organization slug cannot exceed ${MAX_SLUG_LENGTH} characters.`);
  }
  if (!matchesSlugPattern(slug)) {
    throw new OrganizationError(
      'Organization slug must be lowercase alphanumeric characters separated by single hyphens (e.g. "acme-motors").',
    );
  }
  return slug;
}

/**
 * Resolves the slug to persist for a new organization: validates an
 * explicit slug as-is, or derives and validates one from `name` when none
 * is given (Clerk-style auto-derivation). Uniqueness against existing
 * organizations is enforced separately by each `OrganizationRepository`
 * adapter (a real unique index in `@uniora/postgres`), since only the
 * storage layer can check that safely.
 */
export function resolveOrganizationSlug(name: string, explicitSlug?: string): string {
  if (explicitSlug !== undefined) return assertValidSlug(explicitSlug);

  const derived = slugify(name);
  if (derived.length === 0) {
    throw new OrganizationError(
      "Could not derive a URL-safe slug from this organization name — pass an explicit `slug`.",
    );
  }
  return derived;
}
