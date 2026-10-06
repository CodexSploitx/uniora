/**
 * Every error UNIORA throws on purpose carries a stable, machine-readable `code`, so an application
 * can translate it or branch on it without comparing the English `message` (which may be reworded).
 * Codes are part of the public API: they are only ever added, never renamed or repurposed.
 */
export class UnioraError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "UnioraError";
  }
}

export type MembershipErrorCode =
  | "membership_not_found"
  | "membership_exists"
  | "membership_blocked"
  | "role_not_found"
  | "role_wrong_organization"
  | "owner_role_protected"
  | "not_owner_role"
  | "last_owner"
  | "identity_aliased"
  | "identity_link_busy"
  | "membership_invalid";

export type RoleErrorCode =
  | "role_not_found"
  | "role_exists"
  | "role_key_exists"
  | "role_name_invalid"
  | "role_key_invalid"
  | "role_key_reserved"
  | "role_permission_invalid"
  | "owner_role_protected"
  | "owner_role_exists"
  | "role_invalid";

export type PermissionErrorCode =
  | "permission_not_found"
  | "permission_in_use"
  | "permission_name_invalid"
  | "permission_key_invalid"
  | "permission_invalid";

export type FeatureErrorCode =
  | "feature_unknown"
  | "feature_in_use"
  | "feature_has_children"
  | "feature_name_invalid"
  | "feature_key_invalid"
  | "feature_parent_invalid"
  | "feature_invalid";

export type OrganizationErrorCode =
  | "organization_not_found"
  | "organization_exists"
  | "organization_slug_taken"
  | "organization_name_invalid"
  | "organization_slug_invalid"
  | "organization_status_invalid"
  | "organization_update_empty"
  | "organization_invalid";

export type IdentityLinkErrorCode =
  | "identity_link_self"
  | "identity_link_conflict"
  | "identity_link_busy"
  | "identity_link_invalid";

type Rule = readonly [RegExp, string];

/**
 * Maps the message of an error thrown from the existing storage code paths to its stable code. Newer
 * code passes the code explicitly; this table keeps every older throw site (three storage backends)
 * coded without a second copy of each rule, and `errors.test.ts` pins the whole table.
 */
const RULES: Record<string, readonly Rule[]> = {
  membership: [
    [/^Membership not found/, "membership_not_found"],
    [/already has a membership in organization|A membership with id .* already exists/, "membership_exists"],
    [/^Role not found/, "role_not_found"],
    [/belongs to a different organization|does not exist or belongs to a different/, "role_wrong_organization"],
    [/protected Owner role "[^"]*" via assignRole|protected Owner role "[^"]*" via unassignRole/, "owner_role_protected"],
    [/is not the protected Owner role/, "not_owner_role"],
    [/last Owner/, "last_owner"],
    [/linked as an alias of another identity/, "identity_aliased"],
    [/too much concurrent identity-linking/, "identity_link_busy"],
    [/is blocked/, "membership_blocked"],
  ],
  role: [
    [/^Role not found/, "role_not_found"],
    [/A role with key .* already exists|unique key from this role name/, "role_key_exists"],
    [/A role (named|with id) .* already exists/, "role_exists"],
    [/Role name/, "role_name_invalid"],
    [/is reserved for the protected Owner role/, "role_key_reserved"],
    [/Role key|derive a key from this role/, "role_key_invalid"],
    [/Permission key must be a non-empty/, "role_permission_invalid"],
    [/protected Owner role/, "owner_role_protected"],
    [/already has an Owner role/, "owner_role_exists"],
  ],
  permission: [
    [/^Permission not found/, "permission_not_found"],
    [/still granted to at least one role/, "permission_in_use"],
    [/Permission name/, "permission_name_invalid"],
    [/Permission key/, "permission_key_invalid"],
  ],
  feature: [
    [/is not registered/, "feature_unknown"],
    [/still enabled for at least one organization/, "feature_in_use"],
    [/Feature name/, "feature_name_invalid"],
    [/Feature key|derive a key from this feature/, "feature_key_invalid"],
  ],
  organization: [
    [/An organization with slug .* already exists|unique slug from this organization name/, "organization_slug_taken"],
    [/An organization with id .* already exists/, "organization_exists"],
    [/Organization name/, "organization_name_invalid"],
    [/Organization slug|URL-safe slug/, "organization_slug_invalid"],
  ],
  identity_link: [
    [/to itself/, "identity_link_self"],
    [/too much concurrent|concurrently/, "identity_link_busy"],
    [/./, "identity_link_conflict"],
  ],
};

/** The stable code for a message thrown by `domain`'s older throw sites; `<domain>_invalid` when unrecognised. */
export function inferErrorCode(domain: keyof typeof RULES, message: string): string {
  for (const [pattern, code] of RULES[domain] ?? []) if (pattern.test(message)) return code;
  return `${domain}_invalid`;
}
