/**
 * The API scopes as the browser needs them. A client component must not import `@uniora/core` (the whole library would land in
 * the bundle), so the list is repeated here and `api-scopes.test.ts` fails if it ever differs from the one in Core.
 * `sensitive` scopes act on behalf of a user and are shown with a warning.
 */
export const API_SCOPE_META = {
  check: { sensitive: false },
  "organizations:read": { sensitive: false },
  "organizations:create": { sensitive: false },
  "members:write": { sensitive: true },
  "roles:write": { sensitive: true },
  "teams:write": { sensitive: true },
  "policies:write": { sensitive: true },
  "invitations:write": { sensitive: true },
  "audit:read": { sensitive: false },
  "actor:assert": { sensitive: true },
} as const;

export type ApiScopeName = keyof typeof API_SCOPE_META;
export const API_SCOPE_NAMES = Object.keys(API_SCOPE_META) as ApiScopeName[];
