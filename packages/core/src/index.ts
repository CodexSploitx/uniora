export type { Identity } from "./identity/types.js";
export { sameIdentity } from "./identity/types.js";

export type { Organization } from "./organization/types.js";
export type {
  CreateOrganizationInput,
  OrganizationCursor,
  OrganizationRepository,
  SearchOrganizationsOptions,
} from "./organization/repository.js";
export type {
  CreateOrganizationWithOwnerInput,
  CreateOrganizationWithOwnerResult,
} from "./organization/create-with-owner.js";
export { createOrganizationWithOwner } from "./organization/create-with-owner.js";
export { OrganizationError, assertValidSlug, resolveOrganizationSlug, sanitizeOrganizationName, slugify } from "./organization/slug.js";

export type { Membership } from "./membership/types.js";
export type { CreateMembershipInput, MembershipListing, MembershipRepository, SearchMembershipsOptions } from "./membership/repository.js";
export { MembershipError } from "./membership/repository.js";

export type { Role } from "./role/types.js";
export type { CreateOwnerRoleInput, CreateRoleInput, RoleRepository, RoleSummary, SearchRolesOptions } from "./role/repository.js";
export { RoleError } from "./role/repository.js";
export {
  assertNonEmptyPermissionKey,
  assertValidRoleKey,
  resolveRoleKey,
  sanitizeRoleName,
  sanitizeRolePermissionKeys,
} from "./role/key.js";

export type { Permission } from "./permission/types.js";
export type { PermissionRepository, RegisterPermissionInput, SearchPermissionsOptions } from "./permission/repository.js";
export { PermissionError } from "./permission/repository.js";
export { assertValidPermissionKey, sanitizePermissionName } from "./permission/key.js";

export type { Feature, FeatureDefinition } from "./feature/types.js";
export type { FeatureRepository, FeatureUsage, RegisterFeatureInput, SearchFeaturesOptions } from "./feature/repository.js";
export { FeatureError } from "./feature/repository.js";
export { assertValidFeatureKey, resolveFeatureKey, sanitizeFeatureName } from "./feature/key.js";

export type { AuditLogEntry, AuditLogTarget } from "./audit-log/types.js";
export type {
  AuditLogCursor,
  AuditLogRepository,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
} from "./audit-log/repository.js";

export type { IdentityLink } from "./identity-link/types.js";
export type { IdentityLinkRepository, LinkIdentityInput } from "./identity-link/repository.js";
export { IdentityLinkError } from "./identity-link/repository.js";

export type { Invitation, InvitationDelivery, InvitationDeliveryStatus, InvitationStatus } from "./invitation/types.js";
export { isInvitationUsable } from "./invitation/types.js";
export type {
  CreateInvitationInput,
  InvitationFailureReason,
  InvitationRepository,
  RecordDeliveryInput,
  SearchInvitationsOptions,
} from "./invitation/repository.js";
export { InvitationError } from "./invitation/repository.js";
export type {
  DeliveryRetryOptions,
  InvitationMessage,
  InvitationSender,
  SendContext,
  SendOutcome,
} from "./invitation/delivery.js";
export { InvitationDeliveryError, sanitizeDeliveryError, sendWithRetry } from "./invitation/delivery.js";
export type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  DeliveryOutcome,
  InvitationPreview,
  InvitationRateLimits,
  InvitationRef,
  InvitationService,
  InvitationServiceOptions,
  InviteInput,
  InviteResult,
} from "./invitation/service.js";
export { createInvitationService, normalizeInvitationEmail } from "./invitation/service.js";
export { generateInvitationToken, hashInvitationToken, INVITATION_TOKEN_PREFIX } from "./invitation/token.js";

export type { UnioraStorage, UnioraTransaction } from "./storage/types.js";
export { createMemoryStorage } from "./storage/memory.js";

export type {
  AccessCheckInput,
  AuthorizationDecision,
  AuthorizationEngine,
  AuthorizationEngineOptions,
  CanInput,
} from "./authorization/engine.js";
export { createAuthorizationEngine } from "./authorization/engine.js";
export type { AuthorizationSnapshot, ComputeAuthorizationSnapshotInput } from "./authorization/snapshot.js";
export { computeAuthorizationSnapshot } from "./authorization/snapshot.js";
