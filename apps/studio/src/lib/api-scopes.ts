/**
 * The API scopes as the browser needs them. A client component must not import `@uniora/core` (the whole library would land in
 * the bundle), so the list is repeated here and `api-scopes.test.ts` fails if it ever differs from the one in Core.
 * `sensitive` scopes act on behalf of a user and are shown with a warning.
 */
export const API_SCOPE_META = {
  check: { sensitive: false, group: "decide" },
  "organizations:read": { sensitive: false, group: "read" },
  "audit:read": { sensitive: false, group: "read" },
  "organizations:create": { sensitive: false, group: "provision" },
  "members:write": { sensitive: true, group: "administer" },
  "roles:write": { sensitive: true, group: "administer" },
  "teams:write": { sensitive: true, group: "administer" },
  "policies:write": { sensitive: true, group: "administer" },
  "invitations:write": { sensitive: true, group: "administer" },
  "actor:assert": { sensitive: true, group: "delegate" },
} as const;

export type ApiScopeName = keyof typeof API_SCOPE_META;
export const API_SCOPE_NAMES = Object.keys(API_SCOPE_META) as ApiScopeName[];

export type ApiScopeGroup = (typeof API_SCOPE_META)[ApiScopeName]["group"];
/** The order the categories are shown in: from the harmless to the powerful. */
export const API_SCOPE_GROUPS: readonly ApiScopeGroup[] = ["decide", "read", "provision", "administer", "delegate"];

export const scopesOfGroup = (group: ApiScopeGroup): ApiScopeName[] => API_SCOPE_NAMES.filter((scope) => API_SCOPE_META[scope].group === group);

/** Starting points for the usual kinds of backend. Picking one only fills the selection: it can still be adjusted. */
export const API_SCOPE_PRESETS: readonly { id: "checks" | "readonly" | "signup" | "admin"; scopes: readonly ApiScopeName[] }[] = [
  { id: "checks", scopes: ["check"] },
  { id: "readonly", scopes: ["check", "organizations:read", "audit:read"] },
  { id: "signup", scopes: ["organizations:create"] },
  { id: "admin", scopes: ["check", "organizations:read", "members:write", "roles:write", "teams:write", "policies:write", "invitations:write", "actor:assert"] },
];

/** The scopes that act on behalf of a user and so do nothing without `actor:assert`. */
export const needsActorAssert = (scopes: readonly ApiScopeName[]): boolean =>
  !scopes.includes("actor:assert") && scopes.some((scope) => API_SCOPE_META[scope].group === "administer");
