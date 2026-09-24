export const MAX_SLUG_LENGTH = 63;

// Lowercase alphanumeric segments separated by single hyphens — no
// leading, trailing, or duplicate hyphens (same shape Clerk/Better Auth
// enforce for their own slugs/keys).
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function matchesSlugPattern(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * Derives a URL/identifier-safe slug from free text (e.g. "Acme del
 * Oeste" -> "acme-del-oeste", "Organización" -> "organizacion"). Strips
 * diacritics via Unicode NFKD decomposition rather than dropping
 * non-ASCII letters outright, so accented Latin text still produces a
 * meaningful slug instead of an empty one.
 *
 * Shared by every domain that derives a stable, machine-safe identifier
 * from a display name — Organization slugs and Role keys today.
 */
export function deriveSlug(input: string, maxLength: number = MAX_SLUG_LENGTH): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}
