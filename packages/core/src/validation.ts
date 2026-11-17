/**
 * `@uniora/core/validation` — the pure helpers of UNIORA, safe to import in a browser bundle.
 *
 * Everything exported here is plain text and number handling (names, slugs, keys, limits) plus the error classes
 * those helpers throw. This entry point and everything it imports reach no `node:*` module, no I/O and no
 * storage, so a client component can validate a form with the same rules the server enforces:
 *
 * ```ts
 * import { resolveOrganizationSlug, sanitizeOrganizationName } from "@uniora/core/validation";
 * ```
 *
 * A test (`validation.test.ts`) walks the import graph of this file and fails if a Node built-in ever enters it.
 * The root entry point (`@uniora/core`) keeps exporting all of this too, plus the server-side parts.
 */

export { UnioraError } from "./shared/errors.js";
export type {
  FeatureErrorCode,
  IdentityLinkErrorCode,
  MembershipErrorCode,
  OrganizationErrorCode,
  PermissionErrorCode,
  RoleErrorCode,
} from "./shared/errors.js";

export { sameIdentity } from "./identity/types.js";
export type { Identity } from "./identity/types.js";

export { MAX_STATUS_REASON_LENGTH, assertOrganizationStatus, sanitizeStatusReason } from "./organization/status.js";
export { ORGANIZATION_STATUSES } from "./organization/types.js";
export type { OrganizationStatus } from "./organization/types.js";
export { OrganizationError, assertValidSlug, resolveOrganizationSlug, sanitizeOrganizationName, slugify } from "./organization/slug.js";

export { RoleError } from "./role/repository.js";
export {
  MAX_ROLE_DESCRIPTION_LENGTH,
  assertValidRoleKey,
  normalizeRoleName,
  resolveRoleKey,
  sanitizeRoleDescription,
  sanitizeRoleName,
} from "./role/key.js";

export { PermissionError } from "./permission/repository.js";
export { assertValidPermissionKey, sanitizePermissionName } from "./permission/key.js";

export { FeatureError } from "./feature/repository.js";
export { assertValidFeatureKey, resolveFeatureKey, sanitizeFeatureName } from "./feature/key.js";

export {
  MAX_TEAM_DATA_BYTES,
  MAX_TEAM_DEPTH,
  MAX_TEAM_EXTERNAL_ID_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  MAX_TEAM_REASON_LENGTH,
  TeamError,
  resolveTeamSlug,
  sanitizeTeamData,
  sanitizeTeamExternalId,
  sanitizeTeamName,
  sanitizeTeamReason,
} from "./team/repository.js";

export { cleanAvatarUrl, cleanProfileText } from "./profile/profiles.js";
