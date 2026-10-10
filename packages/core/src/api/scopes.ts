/**
 * What an API client may call. A scope grants one family of routes; the route table of `@uniora/server` names exactly one
 * scope per route, and a test fails if a route names none. `actor:assert` is separate on purpose: it lets a client speak
 * for an end user, which is the most sensitive power a key can hold.
 */
export const API_SCOPES = {
  check: { description: "Ask whether an identity may do something (can, authorize, access checks, snapshots).", sensitive: false },
  "organizations:read": { description: "Read organizations, members, roles, permissions, features, teams and policies.", sensitive: false },
  "organizations:create": { description: "Create an organization together with its first Owner.", sensitive: false },
  "members:write": { description: "Assign and remove roles, block, suspend and remove members, on behalf of a user.", sensitive: true },
  "roles:write": { description: "Create, edit and delete roles and their permissions, on behalf of a user.", sensitive: true },
  "teams:write": { description: "Manage teams and their members, on behalf of a user.", sensitive: true },
  "policies:write": { description: "Manage an organization's policies, on behalf of a user.", sensitive: true },
  "invitations:write": { description: "Invite, resend and revoke invitations, on behalf of a user.", sensitive: true },
  "audit:read": { description: "Read an organization's audit log.", sensitive: false },
  "actor:assert": { description: "Act on behalf of an end user. A key with this scope can speak for ANY user of its organizations.", sensitive: true },
} as const;

export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_LIST = Object.keys(API_SCOPES) as readonly ApiScope[];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && Object.hasOwn(API_SCOPES, value);
}

/** Identity providers UNIORA uses for its own principals in the audit log. An end user can never be one of these. */
export const RESERVED_IDENTITY_PROVIDERS = ["uniora-api", "uniora-studio", "uniora-cli", "uniora-platform"] as const;

export function isReservedIdentityProvider(provider: string): boolean {
  return (RESERVED_IDENTITY_PROVIDERS as readonly string[]).includes(provider);
}
